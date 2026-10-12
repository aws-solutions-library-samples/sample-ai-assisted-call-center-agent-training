import { useEffect, useState } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Grid from '@cloudscape-design/components/grid';
import Button from '@cloudscape-design/components/button';
import Badge, { type BadgeProps } from '@cloudscape-design/components/badge';
import Icon from '@cloudscape-design/components/icon';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import DatePicker from '@cloudscape-design/components/date-picker';
import Alert from '@cloudscape-design/components/alert';
import Spinner from '@cloudscape-design/components/spinner';
import { getDailySummary } from '../services/summary';
import { getGradeColor } from '../utils/scoringUtils';
import type { DailySummary as DailySummaryData, SummaryCriterion, SummaryOpportunity } from '../types';

interface DailySummaryProps {
  /** Start a practice session, optionally preselecting a scenario */
  onPractice: (scenarioId?: string) => void;
}

// Deltas smaller than this (in percentage points) are shown as flat
const TREND_EPSILON = 1;

function toDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse 'YYYY-MM-DD' as a local date (Date('YYYY-MM-DD') would be UTC). */
function fromDateString(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtPct(n: number | null | undefined): string {
  return n == null ? '--' : `${Math.round(n)}%`;
}

function trimPeriod(s: string): string {
  return s.replace(/\.\s*$/, '');
}

function scoreBadgeColor(pct: number): BadgeProps['color'] {
  if (pct >= 85) return 'green';
  if (pct >= 70) return 'severity-medium';
  return 'red';
}

const TrendIcon = ({ delta }: { delta: number | null }) => {
  if (delta == null || Math.abs(delta) < TREND_EPSILON) {
    return <Icon name="subtract-minus" variant="subtle" ariaLabel="No change" />;
  }
  return delta > 0
    ? <Icon name="arrow-up" variant="success" ariaLabel={`Up ${Math.round(delta)} points`} />
    : <Icon name="arrow-down" variant="error" ariaLabel={`Down ${Math.round(-delta)} points`} />;
};

const SectionLabel = ({ children, color }: { children: React.ReactNode; color: 'text-status-success' | 'text-status-warning' | 'text-status-info' }) => (
  <Box variant="h3" color={color}>{children}</Box>
);

function strengthDetail(c: SummaryCriterion, trendDays: number): string {
  let text = `Passed on ${c.passedCount} of ${c.callCount} call${c.callCount === 1 ? '' : 's'}`;
  if (c.delta != null && c.delta >= TREND_EPSILON) {
    text += ` — up from ${fmtPct(c.priorPct)} over the previous ${trendDays} days to ${fmtPct(c.pct)}`;
  }
  return `${text}.`;
}

function opportunityDetail(c: SummaryCriterion, trendDays: number): string {
  const missed = c.callCount - c.passedCount;
  let text = `Averaging ${fmtPct(c.pct)}`;
  if (missed > 0) text += `, missed on ${missed} of ${c.callCount} call${c.callCount === 1 ? '' : 's'}`;
  if (c.delta != null && c.delta <= -TREND_EPSILON) {
    text += ` — trending down from ${fmtPct(c.priorPct)} over the previous ${trendDays} days`;
  }
  return `${text}.`;
}

const OpportunityCard = ({ item, trendDays, onPractice }: {
  item: SummaryOpportunity;
  trendDays: number;
  onPractice: (scenarioId?: string) => void;
}) => (
  <Container>
    <SpaceBetween size="s">
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <Box variant="h4">{trimPeriod(item.description)}</Box>
        <Badge color={item.criticality === 'Critical' ? 'severity-high' : 'grey'}>
          {item.criticality === 'Critical' ? 'Critical' : item.sectionName}
        </Badge>
      </SpaceBetween>
      <Box variant="p" color="text-body-secondary">{opportunityDetail(item, trendDays)}</Box>
      {item.topPerformers && (
        <div style={{ borderLeft: '3px solid #037f0c', paddingLeft: 12 }}>
          <Box variant="small" fontWeight="bold" color="text-status-success">WHAT TOP PERFORMERS DO</Box>
          <Box variant="p">
            The top 10% of trainees pass this on {fmtPct(item.topPerformers.passRate)} of
            calls, averaging {fmtPct(item.topPerformers.avgPct)}. You passed it on {item.passedCount} of {item.callCount}.
          </Box>
        </div>
      )}
      <Box float="right">
        <Button
          variant="inline-link"
          iconName="angle-right"
          iconAlign="right"
          ariaLabel={item.practiceScenario ? `Practice ${item.practiceScenario.name}` : 'Practice now'}
          onClick={() => onPractice(item.practiceScenario?.id)}
        >
          Practice now
        </Button>
      </Box>
    </SpaceBetween>
  </Container>
);

export const DailySummary = ({ onPractice }: DailySummaryProps) => {
  const [date, setDate] = useState<string>(toDateString(new Date()));
  // Result is tagged with the date it was loaded for; loading is derived
  const [result, setResult] = useState<{ date: string; summary?: DailySummaryData; error?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDailySummary(fromDateString(date))
      .then(summary => { if (!cancelled) setResult({ date, summary }); })
      .catch(err => {
        console.error('Failed to load daily summary:', err);
        if (!cancelled) setResult({ date, error: 'Failed to load your performance summary.' });
      });
    return () => { cancelled = true; };
  }, [date]);

  const loading = result?.date !== date;
  const summary = loading ? null : result?.summary ?? null;
  const error = loading ? null : result?.error ?? null;

  const isToday = date === toDateString(new Date());
  const dayLabel = fromDateString(date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const trendDays = summary?.window.trendDays ?? 7;

  const header = (
    <Header
      variant="h1"
      description={summary ? `${dayLabel} • ${summary.callCount} call${summary.callCount === 1 ? '' : 's'} scored` : dayLabel}
      actions={
        <DatePicker
          value={date}
          onChange={({ detail }) => detail.value && setDate(detail.value)}
          isDateEnabled={d => d <= new Date()}
          placeholder="YYYY/MM/DD"
          openCalendarAriaLabel={selected => `Choose summary date${selected ? `, selected date is ${selected}` : ''}`}
        />
      }
    >
      Daily Performance Summary
    </Header>
  );

  if (loading) {
    return (
      <SpaceBetween size="l">
        {header}
        <Box textAlign="center" padding="xl"><Spinner size="large" /></Box>
      </SpaceBetween>
    );
  }

  if (error || !summary) {
    return (
      <SpaceBetween size="l">
        {header}
        <Alert type="error">{error}</Alert>
      </SpaceBetween>
    );
  }

  if (summary.callCount === 0) {
    return (
      <SpaceBetween size="l">
        {header}
        <Container>
          <Box textAlign="center" padding="l">
            <SpaceBetween size="m">
              <Box variant="p" color="text-body-secondary">
                No scored calls {isToday ? 'yet today' : 'on this day'}.
              </Box>
              <Button variant="primary" iconName="call" onClick={() => onPractice()}>
                Start a practice session
              </Button>
            </SpaceBetween>
          </Box>
        </Container>
      </SpaceBetween>
    );
  }

  const avg = summary.score.average ?? 0;
  const scoreDelta = summary.score.delta;

  return (
    <SpaceBetween size="l">
      {header}

      {summary.detailedCallCount < summary.callCount && (
        <Alert type="info">
          {summary.callCount - summary.detailedCallCount} of {summary.callCount} calls were scored before
          category tracking was enabled and only count toward the overall score.
        </Alert>
      )}

      <Grid gridDefinition={[{ colspan: { default: 12, m: 3 } }, { colspan: { default: 12, m: 4 } }, { colspan: { default: 12, m: 5 } }]}>
        {/* Score */}
        <SpaceBetween size="s">
          <SectionLabel color="text-status-info">{isToday ? "Today's Score" : 'Score'}</SectionLabel>
          <Container>
            <SpaceBetween size="s">
              <Box fontSize="display-l" fontWeight="bold" color={getGradeColor(avg)}>{fmtPct(avg)}</Box>
              <Box variant="small" color="text-body-secondary">Average score</Box>
              {scoreDelta != null && (
                <SpaceBetween direction="horizontal" size="xxs" alignItems="center">
                  <TrendIcon delta={scoreDelta} />
                  <Box variant="small" color={scoreDelta >= 0 ? 'text-status-success' : 'text-status-error'}>
                    {Math.abs(scoreDelta) < TREND_EPSILON
                      ? `Flat vs. previous ${trendDays} days`
                      : `${scoreDelta > 0 ? 'Up' : 'Down'} ${Math.round(Math.abs(scoreDelta))} pts vs. previous ${trendDays} days`}
                  </Box>
                </SpaceBetween>
              )}
              <ProgressBar value={avg} ariaLabel="Average score" />
              {summary.cohort ? (
                <KeyValuePairs
                  columns={2}
                  items={[
                    { label: 'Cohort average', value: fmtPct(summary.cohort.average) },
                    { label: 'Top 10%', value: fmtPct(summary.cohort.top10) },
                  ]}
                />
              ) : (
                <Box variant="small" color="text-body-secondary">
                  Cohort comparison appears once more trainees have practiced.
                </Box>
              )}
            </SpaceBetween>
          </Container>
        </SpaceBetween>

        {/* Strengths */}
        <SpaceBetween size="s">
          <SectionLabel color="text-status-success"><Icon name="check" /> Strengths</SectionLabel>
          {summary.strengths.length === 0 ? (
            <Container><Box color="text-body-secondary">Keep practicing — strengths appear as criteria reach 85%+.</Box></Container>
          ) : summary.strengths.map(s => (
            <Container key={s.criterionId}>
              <SpaceBetween size="xxs">
                <Box variant="h4">{trimPeriod(s.description)}</Box>
                <Box variant="p" color="text-body-secondary">{strengthDetail(s, trendDays)}</Box>
              </SpaceBetween>
            </Container>
          ))}
        </SpaceBetween>

        {/* Opportunities */}
        <SpaceBetween size="s">
          <SectionLabel color="text-status-warning"><Icon name="suggestions" /> Opportunities</SectionLabel>
          {summary.opportunities.length === 0 ? (
            <Container><Box color="text-body-secondary">No criteria below 80% — nice work.</Box></Container>
          ) : summary.opportunities.map(o => (
            <OpportunityCard key={o.criterionId} item={o} trendDays={trendDays} onPractice={onPractice} />
          ))}
        </SpaceBetween>
      </Grid>

      {/* Detailed scorecard */}
      {summary.sections.length > 0 && (
        <SpaceBetween size="s">
          <Box variant="h3">Detailed Scorecard</Box>
          {summary.sections.map(section => (
            <ExpandableSection
              key={section.sectionId}
              variant="container"
              headerText={section.name}
              headerActions={
                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                  <TrendIcon delta={section.delta} />
                  <Badge color={scoreBadgeColor(section.pct)}>{fmtPct(section.pct)}</Badge>
                </SpaceBetween>
              }
            >
              <SpaceBetween size="xs">
                {section.criteria.map(c => (
                  <SpaceBetween key={c.criterionId} direction="horizontal" size="xs" alignItems="center">
                    <TrendIcon delta={c.delta} />
                    <Badge color={scoreBadgeColor(c.pct)}>{fmtPct(c.pct)}</Badge>
                    <Box>{trimPeriod(c.description)}</Box>
                    <Box variant="small" color="text-body-secondary">
                      passed {c.passedCount}/{c.callCount}
                      {c.priorPct != null && ` • previous ${trendDays} days ${fmtPct(c.priorPct)}`}
                    </Box>
                  </SpaceBetween>
                ))}
              </SpaceBetween>
            </ExpandableSection>
          ))}
        </SpaceBetween>
      )}
    </SpaceBetween>
  );
};
