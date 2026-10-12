"""
Trainee Lambda function — scenario access and session creation.

Provides trainees with:
- GET /scenarios: List all scenarios (summary fields only)
- GET /scenarios/{scenarioId}: Get full scenario by ID
- POST /sessions: Create a session record in DynamoDB when starting a training call
- GET /me/summary: Daily performance summary for the calling trainee (score,
  strengths, opportunities, per-section scorecard, anonymised cohort stats)

Admin operations (CRUD, generate, criteria config) remain in the admin Lambda.

Invoked via API Gateway v2 (HTTP API) with JWT authorizer.
"""

import json
import logging
import math
import os
import boto3
from botocore.config import Config
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal

logger = logging.getLogger()
logger.setLevel(os.environ.get('LOG_LEVEL', 'INFO'))

# Marker appended to the User-Agent header so AWS can attribute service API usage
# to this solution. Set by CDK from the `Solution` CloudFormation mapping.
SOLUTION_USER_AGENT = os.environ.get('USER_AGENT_STRING', '')


def boto_config(**kwargs) -> Config:
    """Return a botocore Config carrying the solution User-Agent marker."""
    if SOLUTION_USER_AGENT:
        kwargs['user_agent_extra'] = SOLUTION_USER_AGENT
    return Config(**kwargs)


dynamodb = boto3.resource('dynamodb', config=boto_config())
SCENARIOS_TABLE = os.environ.get('SCENARIOS_TABLE', '')
SESSIONS_TABLE = os.environ.get('SESSIONS_TABLE', '')

# Daily summary tuning
TREND_DAYS = 7                 # Comparison window before the selected day
MIN_COHORT_SIZE = 3            # Hide cohort stats below this many trainees (privacy)
STRENGTH_THRESHOLD = 85.0      # Criterion avg % at/above which it's a strength
OPPORTUNITY_THRESHOLD = 80.0   # Criterion avg % below which it's an opportunity
MAX_HIGHLIGHTS = 3
MAX_WINDOW = timedelta(days=31)
# Web UI sessions use gsiPk='ALL', Amazon Connect sessions use 'SESSION'
SESSION_GSI_PKS = ('ALL', 'SESSION')


class DecimalEncoder(json.JSONEncoder):
    """Handle DynamoDB Decimal types in JSON serialization."""
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o == int(o) else float(o)
        return super().default(o)


def _http_response(status_code, body):
    """Return an API Gateway v2 proxy response."""
    return {
        'statusCode': status_code,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps(body, cls=DecimalEncoder),
    }


def list_scenarios():
    """List all scenarios (summary fields only)."""
    if not SCENARIOS_TABLE:
        return []
    table = dynamodb.Table(SCENARIOS_TABLE)
    response = table.scan(
        ProjectionExpression='scenarioId, #n, difficulty, caller_gender, characters',
        ExpressionAttributeNames={'#n': 'name'},
    )
    items = response.get('Items', [])
    while 'LastEvaluatedKey' in response:
        response = table.scan(
            ProjectionExpression='scenarioId, #n, difficulty, caller_gender, characters',
            ExpressionAttributeNames={'#n': 'name'},
            ExclusiveStartKey=response['LastEvaluatedKey'],
        )
        items.extend(response.get('Items', []))
    items.sort(key=lambda x: x.get('name', ''))
    return items


def get_scenario(scenario_id: str) -> dict:
    """Get a single scenario by ID (all fields)."""
    if not SCENARIOS_TABLE:
        return {}
    table = dynamodb.Table(SCENARIOS_TABLE)
    response = table.get_item(Key={'scenarioId': scenario_id})
    return response.get('Item', {})


def create_session(body: dict, claims: dict) -> dict:
    """Create a new session record in DynamoDB when a trainee starts a call."""
    if not SESSIONS_TABLE:
        return {'error': 'Sessions table not configured'}

    session_id = body.get('sessionId', '')
    scenario_id = body.get('scenarioId', '')
    scenario_name = body.get('scenarioName', '')
    customer_mood = body.get('customerMood', '')
    difficulty = body.get('difficulty', '')

    if not session_id or not scenario_id:
        return {'error': 'sessionId and scenarioId are required'}

    # Extract user info from JWT claims
    user_id = claims.get('sub', '')
    user_name = claims.get('name', claims.get('email', ''))

    table = dynamodb.Table(SESSIONS_TABLE)
    item = {
        'userId': user_id,
        'sessionId': session_id,
        'userName': user_name,
        'scenarioId': scenario_id,
        'scenarioName': scenario_name,
        'customerMood': customer_mood,
        'difficulty': difficulty,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'gsiPk': 'ALL',
    }
    table.put_item(Item=item)
    return {'session': item}


def _parse_ts(value):
    """Parse an ISO-8601 timestamp (with or without offset / 'Z') as aware UTC."""
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _query_all(table, **kwargs):
    """Run a DynamoDB query, following pagination."""
    response = table.query(**kwargs)
    items = response.get('Items', [])
    while 'LastEvaluatedKey' in response:
        kwargs['ExclusiveStartKey'] = response['LastEvaluatedKey']
        response = table.query(**kwargs)
        items.extend(response.get('Items', []))
    return items


def _scored_in_range(items, start, end):
    """Return scored items whose timestamp is in [start, end), with '_ts' attached."""
    result = []
    for item in items:
        ts = _parse_ts(item.get('timestamp'))
        if item.get('score') is None or ts is None or not (start <= ts < end):
            continue
        result.append({**item, '_ts': ts})
    return result


def _avg(values):
    return round(sum(values) / len(values), 1) if values else None


def _delta(current, prior):
    if current is None or prior is None:
        return None
    return round(current - prior, 1)


def _id_sort_key(value: str):
    """Sort '1.10' after '1.9' by comparing numeric parts where possible."""
    return [int(p) if p.isdigit() else p for p in str(value).split('.')]


def _criteria_stats(sessions):
    """Aggregate criteriaScores across sessions, keyed by criterion id."""
    stats = {}
    for s in sessions:
        for cid, c in (s.get('criteriaScores') or {}).items():
            st = stats.setdefault(cid, {
                'criterionId': cid,
                'sectionId': c.get('sectionId', ''),
                'description': c.get('description', ''),
                'criticality': c.get('criticality', ''),
                'pcts': [],
                'passedCount': 0,
                'lowest': None,
            })
            pct = float(c.get('pct', 0))
            st['pcts'].append(pct)
            st['passedCount'] += 1 if c.get('passed') else 0
            if st['lowest'] is None or pct < st['lowest'][0]:
                st['lowest'] = (pct, s.get('scenarioId', ''), s.get('scenarioName', ''))
    return stats


def _section_stats(sessions):
    """Aggregate sectionScores across sessions, keyed by section id."""
    stats = {}
    for s in sessions:
        for sid, sec in (s.get('sectionScores') or {}).items():
            st = stats.setdefault(sid, {'name': sec.get('name', ''), 'pcts': []})
            st['pcts'].append(float(sec.get('pct', 0)))
    return stats


def _cohort_stats(sessions):
    """Anonymised cohort averages and top-performer criterion stats.

    Returns (cohort, top_criteria). cohort is None when fewer than
    MIN_COHORT_SIZE trainees are present so individual scores can't be inferred.
    """
    by_user = defaultdict(list)
    for s in sessions:
        by_user[s['userId']].append(s)
    if len(by_user) < MIN_COHORT_SIZE:
        return None, {}

    user_avgs = {uid: sum(float(x['score']) for x in items) / len(items) for uid, items in by_user.items()}
    ranked = sorted(user_avgs.values())
    # Nearest-rank 90th percentile
    threshold = ranked[max(math.ceil(0.9 * len(ranked)) - 1, 0)]
    top_users = {uid for uid, a in user_avgs.items() if a >= threshold}

    top_sessions = [s for s in sessions if s['userId'] in top_users]
    top_criteria = {
        cid: {
            'avgPct': _avg(st['pcts']),
            'passRate': round(st['passedCount'] / len(st['pcts']) * 100, 1),
        }
        for cid, st in _criteria_stats(top_sessions).items()
    }
    cohort = {
        'average': _avg(list(user_avgs.values())),
        'top10': _avg([user_avgs[uid] for uid in top_users]),
        'traineeCount': len(by_user),
    }
    return cohort, top_criteria


def get_my_summary(claims: dict, query: dict) -> dict:
    """Build the daily performance summary for the calling trainee.

    The day window is supplied by the client as `start`/`end` ISO timestamps
    (so it follows the trainee's local day); defaults to the current UTC day.
    Trends compare against the TREND_DAYS before `start`. Cohort stats cover
    the same trailing window through `end`.
    """
    if not SESSIONS_TABLE:
        return {'error': 'Sessions table not configured'}

    user_id = claims.get('sub', '')
    if not user_id:
        return {'error': 'Unauthenticated'}

    start = _parse_ts(query.get('start'))
    end = _parse_ts(query.get('end'))
    if start is None or end is None:
        start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
    if end <= start or end - start > MAX_WINDOW:
        return {'error': 'Invalid date range'}
    trend_start = start - timedelta(days=TREND_DAYS)

    table = dynamodb.Table(SESSIONS_TABLE)
    own = _query_all(
        table,
        KeyConditionExpression='userId = :uid',
        ExpressionAttributeValues={':uid': user_id},
    )
    current = _scored_in_range(own, start, end)
    prior = _scored_in_range(own, trend_start, start)

    # Cohort: all trainees' sessions in the trailing window. Timestamps are
    # stored in mixed ISO formats, so query with a 1-day margin and filter
    # precisely after parsing.
    since = (trend_start - timedelta(days=1)).isoformat()
    cohort_items = []
    for pk in SESSION_GSI_PKS:
        cohort_items.extend(_query_all(
            table,
            IndexName='TimestampIndex',
            KeyConditionExpression='gsiPk = :pk AND #ts >= :since',
            ExpressionAttributeNames={'#ts': 'timestamp'},
            ExpressionAttributeValues={':pk': pk, ':since': since},
        ))
    cohort, top_criteria = _cohort_stats(_scored_in_range(cohort_items, trend_start, end))

    score_avg = _avg([float(s['score']) for s in current])
    prior_avg = _avg([float(s['score']) for s in prior])

    cur_criteria = _criteria_stats(current)
    prior_criteria = _criteria_stats(prior)
    cur_sections = _section_stats(current)
    prior_sections = _section_stats(prior)

    criteria_rows = {}
    for cid, st in cur_criteria.items():
        pct = _avg(st['pcts'])
        prior_pct = _avg(prior_criteria[cid]['pcts']) if cid in prior_criteria else None
        criteria_rows[cid] = {
            'criterionId': cid,
            'sectionId': st['sectionId'],
            'description': st['description'],
            'criticality': st['criticality'],
            'pct': pct,
            'priorPct': prior_pct,
            'delta': _delta(pct, prior_pct),
            'passedCount': st['passedCount'],
            'callCount': len(st['pcts']),
        }

    sections = []
    for sid in sorted(cur_sections, key=_id_sort_key):
        pct = _avg(cur_sections[sid]['pcts'])
        prior_pct = _avg(prior_sections[sid]['pcts']) if sid in prior_sections else None
        sections.append({
            'sectionId': sid,
            'name': cur_sections[sid]['name'],
            'pct': pct,
            'priorPct': prior_pct,
            'delta': _delta(pct, prior_pct),
            'criteria': sorted(
                (r for r in criteria_rows.values() if r['sectionId'] == sid),
                key=lambda r: _id_sort_key(r['criterionId']),
            ),
        })
    section_names = {s['sectionId']: s['name'] for s in sections}

    strengths = sorted(
        (dict(r) for r in criteria_rows.values() if r['pct'] >= STRENGTH_THRESHOLD),
        key=lambda r: (-(r['delta'] or 0), -r['pct']),
    )[:MAX_HIGHLIGHTS]

    opportunities = []
    for r in sorted(
        (r for r in criteria_rows.values() if r['pct'] < OPPORTUNITY_THRESHOLD),
        key=lambda r: (r['criticality'] != 'Critical', r['pct']),
    )[:MAX_HIGHLIGHTS]:
        _, scenario_id, scenario_name = cur_criteria[r['criterionId']]['lowest']
        opportunities.append({
            **r,
            'topPerformers': top_criteria.get(r['criterionId']),
            'practiceScenario': {'id': scenario_id, 'name': scenario_name} if scenario_id else None,
        })

    for r in strengths + opportunities:
        r['sectionName'] = section_names.get(r['sectionId'], '')

    return {
        'window': {'start': start.isoformat(), 'end': end.isoformat(), 'trendDays': TREND_DAYS},
        'callCount': len(current),
        'detailedCallCount': sum(1 for s in current if s.get('criteriaScores')),
        'score': {'average': score_avg, 'priorAverage': prior_avg, 'delta': _delta(score_avg, prior_avg)},
        'cohort': cohort,
        'sections': sections,
        'strengths': strengths,
        'opportunities': opportunities,
    }


def lambda_handler(event, context):
    """
    Trainee Lambda handler. Supports API Gateway v2 proxy events.
    Routes based on HTTP method + path pattern.
    All authenticated users can access these routes (no admin check).
    """
    try:
        method = event['requestContext']['http']['method']
        path = event['rawPath']
        path_params = event.get('pathParameters') or {}
        claims = event.get('requestContext', {}).get('authorizer', {}).get('jwt', {}).get('claims', {})

        if method == 'GET' and path == '/scenarios':
            scenarios = list_scenarios()
            return _http_response(200, {'scenarios': scenarios})

        elif method == 'GET' and path.startswith('/scenarios/'):
            scenario_id = path_params.get('scenarioId', '')
            if not scenario_id:
                return _http_response(400, {'error': 'scenarioId is required'})
            scenario = get_scenario(scenario_id)
            return _http_response(200, {'scenario': scenario})

        elif method == 'POST' and path == '/sessions':
            body = json.loads(event.get('body') or '{}')
            result = create_session(body, claims)
            if 'error' in result:
                return _http_response(400, result)
            return _http_response(201, result)

        elif method == 'GET' and path == '/me/summary':
            result = get_my_summary(claims, event.get('queryStringParameters') or {})
            if 'error' in result:
                return _http_response(400, result)
            return _http_response(200, result)

        else:
            return _http_response(404, {'error': f'Not found: {method} {path}'})

    except Exception as e:
        logger.exception("Trainee Lambda error: %s", e)
        return _http_response(500, {'error': str(e)})
