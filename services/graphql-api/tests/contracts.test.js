const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapDecisionTrace,
  buildSubmitContextFeedbackPayload,
} = require('../contract-utils');

test('mapDecisionTrace maps v2 payload shape', () => {
  const mapped = mapDecisionTrace({
    id: 'trace-1',
    trace_type: 'output',
    trace_version: 2,
    input_context: { query: 'How many subjects?' },
    reasoning_steps: [{ step: 1, thought: 'count rows' }],
    sources_cited: [{ chunk_id: 'c1', score: 0.91 }],
    output: { summary: 'There are 123 subjects.' },
    confidence: 0.9,
    mistake_type: null,
    intent_resolution: { inferred_intent: 'aggregation' },
    retrieval_plan: { retrieval_mode: 'structured_query' },
    evidence_assembly: { evidence_sufficiency_score: 0.95 },
    execution_mode: { reasoning_mode: 'tool_execution' },
    answer_construction: { answer_type: 'count' },
    outcome_learning: { success: true },
    confidence_decomposition: { retrieval_confidence: 0.9 },
    decision_lineage: { lineage_version: 'v1', source_protocol: { protocol_filename: 'protocol.pdf' } },
    audit_evidence: { audit_grade: 'high', provenance_bundle: { conversion_id: 'conv-1' } },
    human_readable_summary: 'This trace explains exactly how the answer was formed.',
    feedback_events: [{ id: 'fb-1' }],
    validation_result: { outcome: 'valid' },
    scorecard: { composite_response_quality_score: 0.88 },
    learning_recommendation: { recommendation: 'route_to_aggregation_tools' },
    created_at: '2026-03-27T10:00:00Z',
  });

  assert.equal(mapped.id, 'trace-1');
  assert.equal(mapped.traceType, 'output');
  assert.equal(mapped.traceVersion, 2);
  assert.deepEqual(mapped.intentResolution, { inferred_intent: 'aggregation' });
  assert.deepEqual(mapped.decisionLineage, { lineage_version: 'v1', source_protocol: { protocol_filename: 'protocol.pdf' } });
  assert.deepEqual(mapped.auditEvidence, { audit_grade: 'high', provenance_bundle: { conversion_id: 'conv-1' } });
  assert.equal(mapped.humanReadableSummary, 'This trace explains exactly how the answer was formed.');
  assert.deepEqual(mapped.validationResult, { outcome: 'valid' });
  assert.equal(mapped.scorecard.composite_response_quality_score, 0.88);
  assert.deepEqual(mapped.learningRecommendation, { recommendation: 'route_to_aggregation_tools' });
});

test('buildSubmitContextFeedbackPayload merges category and correction payload', () => {
  const payload = buildSubmitContextFeedbackPayload({
    agentRunId: 'run-1',
    decisionTraceId: 'trace-1',
    orgId: 'org-1',
    feedbackType: 'wrong_answer',
    feedbackCategory: 'wrong_answer',
    correctionPayload: {
      corrected_answer: 'There are 123 subjects.',
      expected_value: 123,
      targeted_stage: 'E. Answer Construction',
    },
    feedbackValue: { reason: 'manual check failed' },
    submittedBy: 'user-1',
  });

  assert.equal(payload.feedback_type, 'wrong_answer');
  assert.equal(payload.agent_run_id, 'run-1');
  assert.equal(payload.decision_trace_id, 'trace-1');
  assert.equal(payload.org_id, 'org-1');
  assert.equal(payload.submitted_by, 'user-1');
  assert.deepEqual(payload.feedback_value, {
    reason: 'manual check failed',
    feedback_category: 'wrong_answer',
    correction_payload: {
      corrected_answer: 'There are 123 subjects.',
      expected_value: 123,
      targeted_stage: 'E. Answer Construction',
    },
  });
});

test('buildSubmitContextFeedbackPayload keeps backward compatibility when optional fields are absent', () => {
  const payload = buildSubmitContextFeedbackPayload({
    agentRunId: 'run-2',
    decisionTraceId: 'trace-2',
    orgId: 'org-2',
    feedbackType: 'endorsement',
    feedbackValue: { reason: 'correct' },
    submittedBy: 'user-2',
  });

  assert.equal(payload.feedback_type, 'endorsement');
  assert.deepEqual(payload.feedback_value, { reason: 'correct' });
});
