function mapDecisionTrace(t) {
  return {
    id: t.id,
    traceType: t.trace_type,
    inputContext: t.input_context,
    traceVersion: t.trace_version,
    reasoningSteps: t.reasoning_steps,
    sourcesCited: t.sources_cited,
    output: t.output,
    confidence: t.confidence,
    mistakeType: t.mistake_type || null,
    intentResolution: t.intent_resolution || null,
    retrievalPlan: t.retrieval_plan || null,
    evidenceAssembly: t.evidence_assembly || null,
    executionMode: t.execution_mode || null,
    answerConstruction: t.answer_construction || null,
    outcomeLearning: t.outcome_learning || null,
    confidenceDecomposition: t.confidence_decomposition || null,
    decisionLineage: t.decision_lineage || null,
    auditEvidence: t.audit_evidence || null,
    humanReadableSummary: t.human_readable_summary || null,
    feedbackEvents: t.feedback_events || null,
    validationResult: t.validation_result || null,
    scorecard: t.scorecard || null,
    learningRecommendation: t.learning_recommendation || null,
    // Gap layers
    retrievalReasoning: t.retrieval_reasoning || null,
    decisionAlternatives: t.decision_alternatives || null,
    validationLayer: t.validation_layer || null,
    stepLinkage: t.step_linkage || null,
    feedbackValidation: t.feedback_validation || null,
    createdAt: t.created_at,
  };
}

function buildSubmitContextFeedbackPayload(input) {
  const feedbackValue = {
    ...(input.feedbackValue || {}),
    ...(input.feedbackCategory ? { feedback_category: input.feedbackCategory } : {}),
    ...(input.correctionPayload ? { correction_payload: input.correctionPayload } : {}),
  };

  return {
    agent_run_id: input.agentRunId,
    decision_trace_id: input.decisionTraceId,
    org_id: input.orgId,
    feedback_type: input.feedbackType,
    feedback_value: feedbackValue,
    submitted_by: input.submittedBy,
  };
}

function mapEvaluatorDefinition(e) {
  if (!e) return null;
  return {
    id: e.id,
    orgId: e.org_id || null,
    name: e.name,
    slug: e.slug,
    description: e.description || null,
    category: e.category,
    evaluatorType: e.evaluator_type,
    config: e.config || {},
    isBuiltin: e.is_builtin || false,
    isActive: e.is_active !== false,
    langfuseScoreName: e.langfuse_score_name || null,
    createdBy: e.created_by || null,
    createdAt: e.created_at || null,
  };
}

function mapEvaluatorResult(r) {
  if (!r) return null;
  return {
    id: r.id || r.result_id,
    runId: r.run_id,
    evaluatorId: r.evaluator_id,
    evaluatorName: r.evaluator_name || null,
    evaluatorSlug: r.evaluator_slug || r.evaluatorSlug || null,
    evaluatorCategory: r.evaluator_category || null,
    evaluatorDescription: r.evaluator_description || null,
    isBuiltin: r.is_builtin || false,
    orgId: r.org_id || null,
    status: r.status || 'completed',
    score: r.score != null ? r.score : null,
    verdict: r.verdict || 'unknown',
    details: r.details || {},
    notes: r.notes || null,
    errorMessage: r.error_message || null,
    judgeModel: r.judge_model || null,
    triggeredBy: r.triggered_by || null,
    createdAt: r.created_at || null,
    completedAt: r.completed_at || null,
  };
}

module.exports = {
  mapDecisionTrace,
  buildSubmitContextFeedbackPayload,
  mapEvaluatorDefinition,
  mapEvaluatorResult,
};
