/**
 * Connect Evaluation Form Construct
 *
 * Builds an Amazon Connect evaluation form from the scoring rubric
 * (rubrics/default.json) plus a Contact Lens rule that auto-submits it, so
 * Connect-mode training calls are scored entirely inside Amazon Connect with
 * generative-AI automated evaluations. Results are reviewed in Connect.
 *
 * Mapping:
 *   - Rubric section  → form section   (RefId `s_<sectionId>`)
 *   - Rubric criterion → Yes/No single-select question answered by GEN_AI
 *                       (RefId `q_<criterionId with "." → "_">`, options `yes` / `no`)
 *   - max_points      → question weight (QUESTION_ONLY scoring, weights sum to 100)
 *   - Critical        → "No" is an automatic fail for the whole form
 *
 * The form evaluates the AGENT side of the trainee's inbound CCP contact. The
 * rule fires when post-call analysis is available for contacts tagged with
 * `training_evaluation=true` (set by amazon-connect/TrainingInboundFlow.json).
 */

import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as fs from 'fs';
import * as path from 'path';

/** Connect quota: generative-AI questions answered per automatically evaluated contact. */
const MAX_GEN_AI_QUESTIONS = 10;

interface RubricCriterion {
  description: string;
  criticality: 'Critical' | 'Non-Critical';
  max_points: number;
}

interface RubricSection {
  name: string;
  description?: string;
  criteria: Record<string, RubricCriterion>;
}

interface Rubric {
  sections: Record<string, RubricSection>;
}

export interface ConnectEvaluationFormProps {
  connectInstanceArn: string;
  /** Rubric JSON path. Defaults to rubrics/default.json at the repo root. */
  rubricPath?: string;
}

export const sectionRefId = (sectionId: string) => `s_${sectionId.replace(/\./g, '_')}`;
export const questionRefId = (criterionId: string) => `q_${criterionId.replace(/\./g, '_')}`;

/** Contact attribute set by the inbound training flow on the trainee's contact. */
export const TRAINING_EVALUATION_ATTRIBUTE = 'training_evaluation';

const QUESTION_INSTRUCTIONS =
  'This is a call center training call. The agent is a trainee representative; the customer is a ' +
  'simulated caller. Evaluate only what the agent said and did. Answer "Yes" only if the transcript ' +
  'clearly shows the agent met the requirement in the question. Answer "No" if the agent did not ' +
  'meet it or there is no evidence that they did.';

export class ConnectEvaluationFormConstruct extends Construct {
  public readonly evaluationForm: connect.CfnEvaluationForm;
  public readonly evaluationFormArn: string;
  public readonly evaluationFormId: string;
  public readonly rule: connect.CfnRule;

  constructor(scope: Construct, id: string, props: ConnectEvaluationFormProps) {
    super(scope, id);

    const rubricPath = props.rubricPath ?? path.join(__dirname, '../../../rubrics/default.json');
    const rubric: Rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf-8'));

    const criteria = Object.values(rubric.sections).flatMap((s) => Object.values(s.criteria));
    if (criteria.length > MAX_GEN_AI_QUESTIONS) {
      throw new Error(
        `Rubric has ${criteria.length} criteria, but Connect automated evaluations answer at most ` +
        `${MAX_GEN_AI_QUESTIONS} generative-AI questions per contact. Reduce the rubric or raise the ` +
        'Contact Lens quota and update MAX_GEN_AI_QUESTIONS.',
      );
    }

    // Question weights are proportional to max_points so the Connect percentage
    // equals points earned / points possible. Round to 2 decimals and give the
    // rounding remainder to the last question so the weights sum to exactly 100.
    const totalPoints = criteria.reduce((sum, c) => sum + c.max_points, 0);
    const weights = criteria.map((c) => Math.round((c.max_points / totalPoints) * 10000) / 100);
    const assigned = weights.slice(0, -1).reduce((sum, w) => sum + w, 0);
    weights[weights.length - 1] = Math.round((100 - assigned) * 100) / 100;

    let questionIndex = 0;
    const items: connect.CfnEvaluationForm.EvaluationFormBaseItemProperty[] = Object.entries(rubric.sections).map(
      ([sectionId, section]) => ({
        section: {
          refId: sectionRefId(sectionId),
          title: section.name,
          instructions: section.description,
          items: Object.entries(section.criteria).map(([criterionId, criterion]) => ({
            question: {
              refId: questionRefId(criterionId),
              title: criterion.description,
              instructions: QUESTION_INSTRUCTIONS,
              questionType: 'SINGLESELECT',
              weight: weights[questionIndex++],
              questionTypeProperties: {
                singleSelect: {
                  displayAs: 'RADIO',
                  options: [
                    { refId: 'yes', text: 'Yes', score: 10 },
                    {
                      refId: 'no',
                      text: 'No',
                      score: 0,
                      automaticFail: criterion.criticality === 'Critical',
                    },
                  ],
                  automation: { answerSource: { sourceType: 'GEN_AI' } },
                },
              },
            },
          })),
        },
      }),
    );

    this.evaluationForm = new connect.CfnEvaluationForm(this, 'Form', {
      instanceArn: props.connectInstanceArn,
      title: 'Call Center Training Evaluation',
      description: 'Generated from rubrics/default.json for automated scoring of Connect training calls',
      status: 'ACTIVE',
      items,
      scoringStrategy: { mode: 'QUESTION_ONLY', status: 'ENABLED' },
      autoEvaluationConfiguration: { enabled: true },
      targetConfiguration: { contactInteractionType: 'AGENT' },
    });

    this.evaluationFormArn = this.evaluationForm.attrEvaluationFormArn;
    // arn:aws:connect:<region>:<account>:instance/<instanceId>/evaluation-form/<formId>
    this.evaluationFormId = cdk.Fn.select(1, cdk.Fn.split('evaluation-form/', this.evaluationFormArn));

    this.rule = new connect.CfnRule(this, 'AutoEvaluationRule', {
      instanceArn: props.connectInstanceArn,
      name: 'CallCenterTrainingAutoEvaluation',
      triggerEventSource: { eventSourceName: 'OnPostCallAnalysisAvailable' },
      function: JSON.stringify({
        Version: '2022-11-25',
        RuleFunction: {
          Operator: 'AND',
          Operands: [
            {
              Operator: 'EQUALS',
              Operands: ['true'],
              ComparisonValue: `$.ContactLens.PostCall.ContactAttribute.${TRAINING_EVALUATION_ATTRIBUTE}`,
              Negate: false,
            },
          ],
        },
      }),
      actions: {
        // Contact Lens rules must assign a contact category (named after the rule)
        assignContactCategoryActions: [{}],
        submitAutoEvaluationActions: [{ evaluationFormArn: this.evaluationFormArn }],
      },
      publishStatus: 'PUBLISHED',
    });

    new cdk.CfnOutput(scope, 'ConnectEvaluationFormArn', {
      value: this.evaluationFormArn,
      description: 'Connect evaluation form used to score training calls',
    });
  }
}
