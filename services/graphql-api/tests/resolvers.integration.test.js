const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { resolvers, SERVICES } = require('../index');

test('decisionTraces resolver: fetches context-graph traces and returns mapped GraphQL shape', async () => {
  const runId = 'run-123';
  const tracesResponse = {
    traces: [
      {
        id: 'trace-1',
        trace_type: 'output',
        trace_version: 2,
        input_context: { query: 'How many unique subjects are there?' },
        reasoning_steps: [{ step: 1, thought: 'Use aggregation path' }],
        sources_cited: [{ chunk_id: 'chunk-1', score: 0.92, excerpt: 'USUBJID values...' }],
        output: { summary: 'There are 123 unique subjects.' },
        confidence: 0.91,
        mistake_type: null,
        intent_resolution: { inferred_intent: 'dataset_aggregation' },
        retrieval_plan: { retrieval_mode: 'structured_query' },
        evidence_assembly: { evidence_sufficiency_score: 0.95 },
        execution_mode: { reasoning_mode: 'tool_execution' },
        answer_construction: { answer_type: 'count' },
        outcome_learning: { success: true },
        confidence_decomposition: { retrieval_confidence: 0.93 },
        decision_lineage: { lineage_version: 'v1', artifact_publication: { artifact_name: 'out.json' } },
        audit_evidence: { audit_grade: 'high', approval_record: { approval_id: 'approval-1' } },
        human_readable_summary: 'This output trace used deterministic aggregation and passed validation.',
        feedback_events: [{ id: 'fb-1' }],
        validation_result: { outcome: 'valid', validator_method: 'aggregation_deterministic_numeric_match' },
        scorecard: { composite_response_quality_score: 0.9 },
        learning_recommendation: { recommendation: 'route_to_aggregation_tools' },
        created_at: '2026-03-27T10:15:00Z',
      },
    ],
  };

  const originalGet = axios.get;
  const calls = [];
  axios.get = async (url) => {
    calls.push(url);
    return { data: tracesResponse };
  };

  try {
    const result = await resolvers.Query.decisionTraces(null, { runId });

    assert.equal(calls.length, 1);
    assert.equal(calls[0], `${SERVICES.contextGraph}/traces/${runId}`);

    assert.equal(Array.isArray(result), true);
    assert.equal(result.length, 1);

    const first = result[0];
    assert.equal(first.id, 'trace-1');
    assert.equal(first.traceType, 'output');
    assert.equal(first.traceVersion, 2);
    assert.deepEqual(first.inputContext, { query: 'How many unique subjects are there?' });
    assert.deepEqual(first.decisionLineage, { lineage_version: 'v1', artifact_publication: { artifact_name: 'out.json' } });
    assert.deepEqual(first.auditEvidence, { audit_grade: 'high', approval_record: { approval_id: 'approval-1' } });
    assert.equal(first.humanReadableSummary, 'This output trace used deterministic aggregation and passed validation.');
    assert.deepEqual(first.validationResult, {
      outcome: 'valid',
      validator_method: 'aggregation_deterministic_numeric_match',
    });
    assert.equal(first.scorecard.composite_response_quality_score, 0.9);
    assert.deepEqual(first.learningRecommendation, { recommendation: 'route_to_aggregation_tools' });
    assert.equal(first.createdAt, '2026-03-27T10:15:00Z');
  } finally {
    axios.get = originalGet;
  }
});

test('submitContextFeedback resolver: posts merged feedback category and correction payload contract', async () => {
  const input = {
    agentRunId: 'run-789',
    decisionTraceId: 'trace-789',
    orgId: 'org-789',
    feedbackType: 'wrong_answer',
    feedbackCategory: 'wrong_answer',
    correctionPayload: {
      corrected_answer: 'There are 123 subjects, not 124.',
      expected_value: 123,
      targeted_stage: 'E. Answer Construction',
      targeted_reasoning_step: 4,
    },
    feedbackValue: {
      reason: 'manual deterministic count disagrees',
      reviewer: 'qa-user',
    },
    submittedBy: 'qa-user',
  };

  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, payload) => {
    calls.push({ url, payload });
    return { data: { feedback_id: 'fb-created-1' } };
  };

  try {
    const result = await resolvers.Mutation.submitContextFeedback(null, { input });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${SERVICES.contextGraph}/feedback`);
    assert.deepEqual(calls[0].payload, {
      agent_run_id: 'run-789',
      decision_trace_id: 'trace-789',
      org_id: 'org-789',
      feedback_type: 'wrong_answer',
      feedback_value: {
        reason: 'manual deterministic count disagrees',
        reviewer: 'qa-user',
        feedback_category: 'wrong_answer',
        correction_payload: {
          corrected_answer: 'There are 123 subjects, not 124.',
          expected_value: 123,
          targeted_stage: 'E. Answer Construction',
          targeted_reasoning_step: 4,
        },
      },
      submitted_by: 'qa-user',
    });
    assert.deepEqual(result, { feedback_id: 'fb-created-1' });
  } finally {
    axios.post = originalPost;
  }
});

test('submitContextFeedback resolver: backwards-compatible payload when category/correction omitted', async () => {
  const input = {
    agentRunId: 'run-basic',
    decisionTraceId: 'trace-basic',
    orgId: 'org-basic',
    feedbackType: 'endorsement',
    feedbackValue: { reason: 'correct' },
    submittedBy: 'user-basic',
  };

  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, payload) => {
    calls.push({ url, payload });
    return { data: { feedback_id: 'fb-created-2' } };
  };

  try {
    const result = await resolvers.Mutation.submitContextFeedback(null, { input });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].payload.feedback_value, { reason: 'correct' });
    assert.equal(calls[0].payload.feedback_type, 'endorsement');
    assert.deepEqual(result, { feedback_id: 'fb-created-2' });
  } finally {
    axios.post = originalPost;
  }
});
