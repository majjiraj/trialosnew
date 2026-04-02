/**
 * TrialOS GraphQL API Gateway
 * Unified GraphQL API over all platform microservices.
 * Supports: queries, mutations, real-time subscriptions (agent status, notifications).
 */
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { ApolloServerPluginDrainHttpServer } = require('@apollo/server/plugin/drainHttpServer');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { WebSocketServer } = require('ws');
const { useServer } = require('graphql-ws/lib/use/ws');
const express = require('express');
const http = require('http');
const cors = require('cors');
const axios = require('axios');
const {
  mapDecisionTrace,
  buildSubmitContextFeedbackPayload,
  mapEvaluatorDefinition,
  mapEvaluatorResult,
} = require('./contract-utils');

const PORT = process.env.PORT || 4000;
const SERVICES = {
  auth:           process.env.AUTH_SERVICE_URL         || 'http://localhost:8001',
  audit:          process.env.AUDIT_SERVICE_URL        || 'http://localhost:8002',
  ingestion:      process.env.INGESTION_SERVICE_URL    || 'http://localhost:8003',
  agentRuntime:   process.env.AGENT_RUNTIME_URL        || 'http://localhost:8004',
  marketplace:    process.env.MARKETPLACE_URL          || 'http://localhost:8005',
  notifications:  process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:8006',
  dataPlatform:   process.env.DATA_PLATFORM_URL        || 'http://localhost:8007',
  contextGraph:   process.env.CONTEXT_GRAPH_URL        || 'http://localhost:8008',
  appComposer:    process.env.APP_COMPOSER_URL         || 'http://localhost:8009',
  formEngine:     process.env.FORM_ENGINE_URL          || 'http://localhost:8010',
  workflowBridge: process.env.WORKFLOW_BRIDGE_URL      || 'http://localhost:8011',
};

// ─── GraphQL Schema ───────────────────────────────────────────────────────────

const typeDefs = `#graphql
  scalar JSON
  scalar DateTime

  # ── Studies ──────────────────────────────────────────────────────────────────
  type Study {
    id: ID!
    name: String!
    protocolNumber: String!
    phase: String
    therapeuticArea: String
    status: String!
    isBlinded: Boolean!
    sites: [Site!]
    subjects: Int
    openQueryCount: Int
    createdAt: DateTime!
  }

  type Site {
    id: ID!
    studyId: ID!
    siteNumber: String!
    name: String!
    country: String
    status: String!
    principalInvestigator: String
  }

  # ── Documents ─────────────────────────────────────────────────────────────────
  type Document {
    id: ID!
    name: String!
    documentType: String!
    version: String!
    status: String!
    sha256Hash: String!
    fileSizeBytes: Int
    createdAt: DateTime!
  }

  # ── Agents ────────────────────────────────────────────────────────────────────
  type AgentDefinition {
    id: ID!
    name: String!
    slug: String!
    version: String!
    category: String!
    description: String!
    publisherType: String!
    agentType: String!
    requiredPermissions: [String!]!
    declaredTools: [String!]!
    isVerified: Boolean!
    isPublished: Boolean!
    flowDefinition: JSON
    agentPurpose: String
    publisherOrgId: ID
  }

  type AgentInstallation {
    id: ID!
    agentId: ID!
    orgId: ID!
    installedVersion: String!
    isActive: Boolean!
    installedAt: DateTime!
    agent: AgentDefinition
  }

  type AgentRun {
    id: ID!
    installationId: ID!
    studyId: ID!
    status: String!
    isTestRun: Boolean!
    startedAt: DateTime
    completedAt: DateTime
    outputSummary: String
    tokensUsed: Int
    llmModel: String
    errorMessage: String
    createdAt: DateTime!
  }

  type AgentRunDetail {
    id: ID!
    installationId: ID!
    studyId: ID!
    status: String!
    agentName: String
    agentType: String
    agentSlug: String
    llmModel: String
    tokensUsed: Int
    stepTraces: JSON
    checkpointData: JSON
    artifacts: JSON
    outputSummary: String
    errorMessage: String
    startedAt: DateTime
    completedAt: DateTime
    createdAt: DateTime!
    sessionId: ID
    latencyMs: Int
    costUsd: Float
    turnCount: Int
    toolCallsTotal: Int
    toolCallsSuccessful: Int
    evaluation: AgentRunEvaluation
  }

  type AgentRunEvaluation {
    id: ID!
    runId: ID!
    sessionId: ID
    taskCompleted: Boolean
    latencyMs: Int
    costUsd: Float
    toolCallsTotal: Int
    toolCallsSuccessful: Int
    toolUsageAccuracy: Float
    faithfulnessScore: Float
    reasoningScore: Float
    hallucinationDetected: Boolean
    hallucinationRate: Float
    judgeModel: String
    judgeVerdict: String
    judgeNotes: String
    evaluator: String
    evaluatedAt: DateTime
  }

  type EvaluatorDefinition {
    id: ID!
    orgId: ID
    name: String!
    slug: String!
    description: String
    category: String!
    evaluatorType: String!
    config: JSON!
    isBuiltin: Boolean!
    isActive: Boolean!
    langfuseScoreName: String
    createdBy: String
    createdAt: DateTime
  }

  type EvaluatorResult {
    id: ID!
    runId: ID!
    evaluatorId: ID!
    evaluatorName: String
    evaluatorSlug: String
    evaluatorCategory: String
    evaluatorDescription: String
    isBuiltin: Boolean
    orgId: ID
    status: String!
    score: Float
    verdict: String
    details: JSON
    notes: String
    errorMessage: String
    judgeModel: String
    triggeredBy: String
    createdAt: DateTime
    completedAt: DateTime
  }

  input EvaluatorCreateInput {
    orgId: ID!
    name: String!
    slug: String!
    description: String
    category: String
    evaluatorType: String!
    config: JSON!
    langfuseScoreName: String
    createdBy: String
  }

  input EvaluatorUpdateInput {
    name: String
    description: String
    category: String
    evaluatorType: String
    config: JSON
    langfuseScoreName: String
    isActive: Boolean
  }

  type MappingCheckpoint {
    runId: ID!
    status: String!
    checkpointData: JSON
    approval: JSON
    stepTraces: JSON
  }

  type EvaluatorTrendPoint {
    day: String
    avgScore: Float
    count: Int
  }

  type EvaluatorRecentResult {
    id: ID!
    runId: ID!
    score: Float
    verdict: String
    notes: String
    details: JSON
    judgeModel: String
    triggeredBy: String
    createdAt: DateTime
    runStatus: String
    runStartedAt: DateTime
  }

  type AgentEvaluatorStat {
    evaluatorId: ID!
    evaluatorName: String!
    evaluatorSlug: String!
    evaluatorCategory: String!
    evaluatorDescription: String
    isBuiltin: Boolean!
    runCount: Int!
    avgScore: Float
    minScore: Float
    maxScore: Float
    scoreStddev: Float
    passCount: Int!
    failCount: Int!
    partialCount: Int!
    unknownCount: Int!
    passRate: Float
    failRate: Float
    lastEvaluatedAt: DateTime
    firstEvaluatedAt: DateTime
    provenanceNarrative: String
    scoringDimensions: [String!]!
    trend: [EvaluatorTrendPoint!]!
    recentResults: [EvaluatorRecentResult!]!
  }

  type AgentEvaluatorSummary {
    agentName: String!
    orgId: String
    totalEvaluations: Int!
    evaluatorCount: Int!
    stats: [AgentEvaluatorStat!]!
  }

  type ApprovalRequest {
    id: ID!
    runId: ID!
    orgId: ID!
    studyId: ID
    title: String!
    description: String
    proposedAction: JSON!
    status: String!
    createdAt: DateTime!
  }

  type SdtmMappingTask {
    id: ID!
    runId: ID!
    orgId: ID!
    studyId: ID
    title: String!
    description: String
    status: String!
    createdAt: DateTime!
  }

  type UsdmMappingTask {
    id: ID!           # approval_id
    conversionId: String!
    runId: String!
    orgId: String!
    studyId: String
    name: String!
    title: String!
    description: String
    status: String!
    taskType: String
    createdAt: String
  }

  # ── Audit ─────────────────────────────────────────────────────────────────────
  type AuditEvent {
    eventId: ID!
    orgId: String!
    studyId: String
    timestamp: DateTime!
    actorType: String!
    actorId: String!
    action: String!
    resourceType: String!
    resourceId: String
    beforeState: JSON
    afterState: JSON
    metadata: JSON
    rowHash: String!
    prevHash: String
    ipAddress: String
    sessionId: String
    isTestRun: Boolean!
  }

  type ChainVerification {
    orgId: String!
    totalEvents: Int!
    chainValid: Boolean!
    brokenLinks: [JSON!]!
  }

  # ── Notifications ─────────────────────────────────────────────────────────────
  type Notification {
    id: ID!
    orgId: String!
    studyId: String
    userId: String!
    notificationType: String!
    severity: String!
    title: String!
    body: String!
    readAt: DateTime
    createdAt: DateTime!
  }

  # ── Documents Budget ──────────────────────────────────────────────────────────
  type BudgetSummary {
    siteId: String
    siteName: String
    totalBudgeted: Float!
    totalActual: Float!
    variancePct: Float!
    status: String!
  }

  # ── Queries ───────────────────────────────────────────────────────────────────
  type DataQuery {
    id: ID!
    studyId: ID!
    siteId: ID
    subjectId: String
    domain: String!
    fieldName: String
    queryText: String!
    raisedByType: String!
    status: String!
    openedAt: DateTime!
    respondedAt: DateTime
  }

  # ── Conformance ───────────────────────────────────────────────────────────────
  type ConformanceSummary {
    domain: String!
    totalErrors: Int!
    totalWarnings: Int!
    checkedAt: DateTime!
    findings: [ConformanceFinding!]!
  }

  type ConformanceFinding {
    ruleId: String!
    severity: String!
    field: String!
    message: String!
  }

  # ── Queries & Mutations ───────────────────────────────────────────────────────
  type Query {
    # Marketplace
    agents(category: String, publisherType: String, search: String, orgId: String): [AgentDefinition!]!
    agent(slug: String!): AgentDefinition

    # Installations
    installations(orgId: String!): [AgentInstallation!]!

    # Agent runs
    agentRuns(studyId: String!, limit: Int): [AgentRun!]!
    agentRun(runId: String!): AgentRun
    agentRunDetail(runId: String!): AgentRunDetail
    mappingCheckpoint(runId: String!): MappingCheckpoint
    agentRunsForOrg(orgId: String!, limit: Int): [AgentRunDetail!]!

    # Approval requests
    approvalRequests(studyId: String!, status: String): [ApprovalRequest!]!
    approvalRequest(id: ID!): ApprovalRequest
    sdtmMappingTasks(orgId: String!, status: String): [SdtmMappingTask!]!
    usdmMappingTasks(orgId: String!): [UsdmMappingTask!]!

    # Audit
    auditEvents(
      orgId: String!
      studyId: String
      actorId: String
      action: String
      resourceType: String
      resourceId: String
      runId: String
      fromTs: String
      toTs: String
      limit: Int
      offset: Int
    ): [AuditEvent!]!
    verifyAuditChain(orgId: String!): ChainVerification!

    # Notifications
    notifications(userId: String!, orgId: String!, unreadOnly: Boolean): [Notification!]!

    # Documents
    documents(orgId: String!, studyId: String, documentType: String): [Document!]!

    # Context graph — legacy direct search
    queryContext(orgId: String!, query: String!, studyId: String, topK: Int, includeLineage: Boolean): ContextQueryResult!
    # Context graph — scoped, bias-corrected retrieval (use this for agents)
    retrievalQuery(orgId: String!, query: String!, studyId: String, installationId: String, topK: Int, maxTokens: Int): RetrievalResult!
    # Decision trace audit graph
    decisionTraceGraph(runId: String!, orgId: String!): JSON!
    # Indexing drift monitoring
    indexingDriftReport(orgId: String!): [DocumentDriftStatus!]!
    # Context pack log for debugging
    contextPackLog(orgId: String!, studyId: String, limit: Int): [ContextPackEntry!]!
    pendingClassifications(orgId: String!): [PendingClassification!]!
    decisionTraces(runId: String!): [DecisionTrace!]!
    agentRunsForSession(sessionId: String!): [AgentRunDetail!]!
    documentTypes(orgId: String!): [DocumentType!]!
    contextLineage(nodeId: String!, depth: Int): JSON!
    # Neo4j reasoning graph for an agent run
    agentRunGraph(runId: String!, orgId: String!): AgentRunGraph!
  }

  type AgentRunGraph {
    nodes: [JSON!]!
    edges: [JSON!]!
    runId: String
  }

  type RetrievalResult {
    query:          String!
    packHash:       String!
    fromCache:      Boolean!
    chunks:         [JSON!]!
    sourcesCited:   [JSON!]!
    scopeSummary:   JSON!
    searchMethod:   String!
    tokenEstimate:  Int
  }

  type DocumentDriftStatus {
    documentId:          String!
    documentName:        String
    indexedChunksCount:  Int!
    totalChunksCount:    Int!
    driftScore:          Float!
    needsReindex:        Boolean!
    lastCheckedAt:       String!
  }

  type ContextPackEntry {
    id:          String!
    packHash:    String!
    queryText:   String!
    tokenCount:  Int
    cacheHit:    Boolean!
    createdAt:   String!
  }

  extend type Query {
    # ACP: Apps
    apps(orgId: String!, status: String, category: String): [AppDefinition!]!
    app(id: ID!, orgId: String): AppDefinition
    appCatalog: [AppDefinition!]!
    appVersions(appId: ID!): [AppVersion!]!
    appInstallations(orgId: String!): [AppInstallation!]!

    # ACP: Workflows
    workflowInstances(orgId: String!, status: String, appId: String, studyId: String, limit: Int): [WorkflowInstance!]!
    workflowInstance(id: ID!): WorkflowInstance
    workflowTask(id: ID!): WorkflowTask
    workflowTasks(orgId: String!, status: String, assigneeId: String, limit: Int): [WorkflowTask!]!
    myTasks(orgId: String!, userId: String!): [WorkflowTask!]!

    # ACP: Forms
    forms(orgId: String!, appId: String, status: String): [FormSchema!]!
    formSchema(formId: ID!): FormSchema
    formSubmissions(orgId: String!, formId: ID!): [FormSubmission!]!

    # ACP: Signatures
    electronicSignatures(orgId: String!, resourceId: ID!): [ElectronicSignature!]!

    # Widgets / Dashboards
    widgets(orgId: String!, studyId: String): [Widget!]!
    widget(id: ID!): Widget
    dashboards(orgId: String!, studyId: String): [Dashboard!]!
    dashboard(id: ID!): Dashboard

    # USDM Protocol Converter
    usdmConversions(orgId: String!, studyId: String): [UsdmConversion!]!
    usdmConversion(id: ID!): UsdmConversion
    validateProtocolDoc(s3Key: String!, filename: String!): ProtocolValidationResult!

    # Evaluators
    evaluatorCatalog: [EvaluatorDefinition!]!
    orgEvaluators(orgId: String!): [EvaluatorDefinition!]!
    runEvaluatorResults(runId: String!): [EvaluatorResult!]!
    agentEvaluatorStats(agentName: String!, orgId: String!): AgentEvaluatorSummary!

    # Test Data Generator
    testDataDomains: TestDataDomains!
  }

  type TestDataDomains {
    SDTM: [String!]!
    ADaM: [String!]!
    CRF: [String!]!
    RawEDC: [String!]!
    Protocol: [String!]!
    TLF: [String!]!
  }

  input GenerateTestDataInput {
    dataType: String!
    subDomains: [String!]!
    outputFormat: String!
    numRows: Int
    addAnomalies: Boolean
    studyId: String
  }

  type GenerateTestDataResult {
    downloadUrl: String!
    filename: String!
    mimeType: String!
    rowsGenerated: Int!
    domains: [String!]!
  }

  type Mutation {
    # Agent install/create
    installAgent(orgId: String!, agentId: String!, installedBy: String!, consentedPermissions: [String!]!): AgentInstallation!
    createUIAgent(input: CreateUIAgentInput!): AgentDefinition!
    createFlowAgent(input: CreateFlowAgentInput!): AgentDefinition!

    # Triggers
    createTrigger(installationId: String!, studyId: String!, triggerType: String!, triggerConfig: JSON!, createdBy: String!): JSON!

    # Agent runs
    startAgentRun(installationId: String!, studyId: String!, orgId: String!, inputContext: JSON, isTestRun: Boolean): AgentRun!

    # Approval decisions
    decideApproval(approvalId: String!, decision: String!, deciderId: String!, note: String): ApprovalRequest!
    resumeAgentRun(runId: String!, approvalId: String!, decision: String!, modifiedSpec: JSON, decidedBy: String!, note: String, restart: Boolean): JSON!

    # Audit
    writeAuditEvent(input: AuditEventInput!): AuditEvent!

    # Notifications
    markNotificationRead(notificationId: String!): Notification!
    setNotificationPreferences(userId: String!, orgId: String!, notificationType: String!, channels: [String!]!, enabled: Boolean!): JSON!

    # Context graph
    submitContextFeedback(input: ContextFeedbackInput!): JSON!
    resolveDocumentClassification(classificationId: String!, resolvedType: String!, resolvedBy: String!): JSON!
    createDocumentType(input: CreateDocumentTypeInput!): JSON!

    # ACP: App lifecycle
    createApp(input: CreateAppInput!): AppDefinition!
    updateApp(id: ID!, input: UpdateAppInput!): AppDefinition!
    publishApp(appId: ID!): AppDefinition!
    installApp(appId: ID!, orgId: String!, consentedPermissions: [String!], customConfig: JSON): AppInstallation!
    submitAppForReview(appId: ID!): AppDefinition!

    # ACP: Workflows
    startWorkflow(input: StartWorkflowInput!): WorkflowInstance!
    terminateWorkflow(instanceId: ID!): WorkflowInstance!

    # ACP: Tasks
    claimTask(taskId: ID!): WorkflowTask!
    completeTask(taskId: ID!, completionData: JSON, esignatureId: ID): WorkflowTask!
    reassignTask(taskId: ID!, newAssigneeId: String!): WorkflowTask!

    # ACP: Forms
    createForm(input: CreateFormInput!): FormSchema!
    submitForm(formId: ID!, data: JSON!, workflowTaskId: ID, instanceId: ID): FormSubmission!

    # ACP: E-signatures
    createElectronicSignature(resourceType: String!, resourceId: ID!, meaning: String!, password: String!): ElectronicSignature!

    # ACP: Agent attachment
    attachAgentToStep(appId: ID!, stepId: String!, agentDefId: ID!, triggerMode: String, triggerCondition: JSON): JSON!
    detachAgentFromStep(appId: ID!, stepId: String!): JSON!

    # Widgets / Dashboards
    createWidget(orgId: String!, studyId: String, name: String!, description: String, chartType: String!, echartsConfig: JSON!, dataSource: JSON, createdBy: String): Widget!
    updateWidget(id: ID!, name: String, description: String, chartType: String, echartsConfig: JSON, dataSource: JSON): Widget!
    deleteWidget(id: ID!): Boolean!
    createDashboard(orgId: String!, studyId: String, name: String!, createdBy: String): Dashboard!
    addWidgetToDashboard(dashboardId: ID!, widgetId: ID!, posX: Int, posY: Int, width: Int, height: Int): DashboardPlacement!
    updateDashboardLayout(dashboardId: ID!, placements: [PlacementInput!]!): Boolean!
    removeWidgetFromDashboard(placementId: ID!): Boolean!
    chatWithWidget(widgetId: ID!, orgId: String!, message: String!, currentOptions: JSON): WidgetChatResponse!

    # USDM Protocol Converter
    createUsdmDraft(orgId: String!, studyId: String, name: String!, createdBy: String): UsdmConversion!
    beginUsdmConversion(id: ID!, protocolDocId: String!, protocolFilename: String!, protocolS3Key: String!, createdBy: String): UsdmConversion!
    startUsdmConversion(orgId: String!, studyId: String, protocolDocId: String!, protocolFilename: String!, protocolS3Key: String!, name: String!, createdBy: String): UsdmConversion!
    updateUsdmConversion(id: ID!, usdmJson: JSON!): UsdmConversion!

    # Evaluators
    triggerEvaluator(runId: String!, evaluatorId: String!, orgId: String!, triggeredBy: String): EvaluatorResult!
    saveEvaluator(input: EvaluatorCreateInput!): EvaluatorDefinition!
    updateEvaluator(id: ID!, input: EvaluatorUpdateInput!): EvaluatorDefinition!
    deleteEvaluator(id: ID!): Boolean!

    # Test Data Generator
    generateTestData(input: GenerateTestDataInput!): GenerateTestDataResult!
  }

  input CreateUIAgentInput {
    orgId: String!
    createdBy: String!
    name: String!
    description: String!
    category: String!
    agentType: String
    triggerType: String
    triggerConfig: JSON
    dataScope: JSON
    declaredTools: [String!]
    systemPrompt: String
    objective: String
    outputFormat: String
    actions: JSON
  }

  input CreateFlowAgentInput {
    orgId: String!
    createdBy: String!
    name: String!
    description: String!
    category: String!
    agentPurpose: String
    dataSources: [String!]
    flowDefinition: JSON!
    outputFormat: String
  }

  input AuditEventInput {
    orgId: String!
    studyId: String
    actorType: String!
    actorId: String!
    action: String!
    resourceType: String!
    resourceId: String
    beforeState: JSON
    afterState: JSON
    ipAddress: String
    sessionId: String
    isTestRun: Boolean
  }

  # ── Context Graph ─────────────────────────────────────────────────────────────

  type ContextEntry {
    text: String!
    score: Float!
    entityType: String
    entityKey: String
    nodeIds: [String!]
  }

  type ContextSource {
    docName: String
    docType: String
    docId: String
    chunkId: String
    nodeId: String
    score: Float
    section: String
    excerpt: String
  }

  type ContextQueryResult {
    query: String!
    results: [ContextEntry!]!
    sourcesCited: [ContextSource!]!
    searchMethod: String!
  }

  type PendingClassification {
    id: ID!
    documentId: String!
    fileName: String
    suggestedTypeCodes: [String!]!
    confidenceScores: JSON
    llmAnalysis: String
    metadataExtracted: JSON
    createdAt: DateTime!
  }

  type DecisionTrace {
    id: ID!
    traceType: String!
    traceVersion: Int
    inputContext: JSON
    reasoningSteps: JSON
    sourcesCited: JSON
    output: JSON
    confidence: Float
    mistakeType: String
    intentResolution: JSON
    retrievalPlan: JSON
    evidenceAssembly: JSON
    executionMode: JSON
    answerConstruction: JSON
    outcomeLearning: JSON
    confidenceDecomposition: JSON
    decisionLineage: JSON
    auditEvidence: JSON
    humanReadableSummary: String
    feedbackEvents: JSON
    validationResult: JSON
    scorecard: JSON
    learningRecommendation: JSON
    retrievalReasoning: JSON
    decisionAlternatives: JSON
    validationLayer: JSON
    stepLinkage: JSON
    feedbackValidation: JSON
    createdAt: DateTime!
  }

  type DocumentType {
    typeCode: String!
    typeName: String!
    description: String
    isSystem: Boolean!
  }

  input ContextFeedbackInput {
    agentRunId: String
    decisionTraceId: String
    orgId: String!
    feedbackType: String!
    feedbackCategory: String
    correctionPayload: JSON
    feedbackValue: JSON!
    submittedBy: String!
  }

  input CreateDocumentTypeInput {
    typeCode: String!
    typeName: String!
    description: String
    orgId: String!
    detectionPatterns: JSON
    schemaHints: JSON
  }

  # ── ACP: App Definitions ──────────────────────────────────────────────────────
  type AppDefinition {
    id: ID!
    orgId: ID!
    name: String!
    slug: String!
    version: String!
    description: String
    category: String!
    bpmnXml: String
    workflowDefinition: JSON
    formIds: JSON
    agentAttachments: JSON
    settings: JSON
    status: String!
    isPublished: Boolean!
    publisherOrgId: ID
    createdBy: ID
    createdAt: DateTime!
    updatedAt: DateTime
  }

  type AppVersion {
    id: ID!
    appId: ID!
    version: String!
    status: String!
    changeType: String!
    changeReason: String!
    changedBy: ID
    name: String!
    description: String
    createdAt: DateTime!
  }

  type AppInstallation {
    id: ID!
    orgId: ID!
    appId: ID!
    installedVersion: String!
    installedBy: ID
    zeebeDeploymentKey: String
    customConfig: JSON
    status: String!
    installedAt: DateTime!
    app: AppDefinition
  }

  # ── ACP: Workflow ──────────────────────────────────────────────────────────────
  type WorkflowInstance {
    id: ID!
    orgId: ID!
    installationId: ID
    appId: ID
    studyId: ID
    zeebeInstanceKey: String
    bpmnProcessId: String
    status: String!
    inputVariables: JSON
    outputVariables: JSON
    slaDeadline: DateTime
    startedAt: DateTime!
    completedAt: DateTime
  }

  type WorkflowTask {
    id: ID!
    orgId: ID!
    instanceId: ID!
    zeebeJobKey: String
    elementId: String
    elementName: String
    formId: String
    assigneeId: ID
    assigneeRole: String
    status: String!
    dueDate: DateTime
    claimedAt: DateTime
    completedAt: DateTime
    completionData: JSON
    esignatureId: ID
    isOverdue: Boolean
    createdAt: DateTime!
    variables: JSON
  }

  # ── ACP: Forms ────────────────────────────────────────────────────────────────
  type FormSchema {
    formId: ID!
    orgId: ID!
    appId: ID
    title: String!
    description: String
    jsonSchema: JSON!
    uiSchema: JSON
    conditionalLogic: JSON
    version: String!
    status: String!
    createdAt: DateTime!
    updatedAt: DateTime
  }

  type FormSubmission {
    submissionId: ID!
    formId: ID!
    orgId: ID!
    workflowTaskId: ID
    instanceId: ID
    submittedBy: ID
    data: JSON!
    status: String!
    esignatureId: ID
    submittedAt: DateTime!
  }

  # ── ACP: E-Signatures ─────────────────────────────────────────────────────────
  type ElectronicSignature {
    id: ID!
    orgId: ID!
    resourceType: String!
    resourceId: ID!
    signerId: ID!
    meaning: String!
    authMethod: String!
    contentHash: String!
    signedAt: DateTime!
  }

  # ── ACP Inputs ────────────────────────────────────────────────────────────────
  input CreateAppInput {
    orgId: String!
    name: String!
    slug: String!
    description: String
    category: String
    bpmnXml: String
    formIds: JSON
    agentAttachments: JSON
    settings: JSON
    createdBy: String!
  }

  input UpdateAppInput {
    name: String
    description: String
    category: String
    bpmnXml: String
    workflowDefinition: JSON
    formIds: JSON
    agentAttachments: JSON
    settings: JSON
  }

  input CreateFormInput {
    orgId: String!
    title: String!
    description: String
    jsonSchema: JSON!
    uiSchema: JSON
    conditionalLogic: JSON
    appId: String
  }

  input StartWorkflowInput {
    orgId: String!
    installationId: String
    appId: String
    studyId: String
    bpmnProcessId: String!
    inputVariables: JSON
    slaDeadline: String
    startedBy: String!
  }

  # ── Subscriptions ─────────────────────────────────────────────────────────────
  type Subscription {
    agentRunUpdated(studyId: String!): AgentRun!
    approvalRequested(orgId: String!): ApprovalRequest!
    notificationReceived(userId: String!): Notification!
    workflowInstanceUpdated(orgId: String!): WorkflowInstance!
    taskAssigned(userId: String!): WorkflowTask!
    appInstallationStatus(orgId: String!): AppInstallation!
  }

  # ── Widget / Dashboard ────────────────────────────────────────────────
  type Widget {
    id: ID!
    orgId: String!
    studyId: String
    name: String!
    description: String
    chartType: String!
    echartsConfig: JSON!
    dataSource: JSON
    createdBy: String
    createdAt: String
    updatedAt: String
  }

  type DashboardPlacement {
    id: ID!
    dashboardId: String!
    widgetId: String!
    widget: Widget
    posX: Int
    posY: Int
    width: Int
    height: Int
  }

  type Dashboard {
    id: ID!
    orgId: String!
    studyId: String
    name: String!
    placements: [DashboardPlacement]
    createdBy: String
    createdAt: String
  }

  type WidgetChatResponse {
    message: String!
    optionPatch: JSON
  }

  input PlacementInput {
    id: String
    widgetId: String!
    posX: Int
    posY: Int
    width: Int
    height: Int
  }

  # ── USDM Protocol Converter ──────────────────────────────────────────────────

  type UsdmConversion {
    id: ID!
    orgId: String!
    studyId: String
    protocolDocId: String
    protocolFilename: String
    protocolS3Key: String
    name: String!
    status: String!
    usdmJson: JSON
    runId: String
    approvalId: String
    createdBy: String
    errorMessage: String
    createdAt: String
    updatedAt: String
  }

  type ProtocolValidationResult {
    isValidProtocol: Boolean!
    confidence: Float!
    matchedIndicators: [String!]!
    wordCount: Int
    error: String
  }
`;

// ─── Resolvers ────────────────────────────────────────────────────────────────

const resolvers = {
  Query: {
    agents: async (_, args) => {
      const params = new URLSearchParams();
      if (args.category) params.set('category', args.category);
      if (args.publisherType) params.set('publisher_type', args.publisherType);
      if (args.search) params.set('search', args.search);
      if (args.orgId) params.set('org_id', args.orgId);
      const { data } = await axios.get(`${SERVICES.marketplace}/agents?${params}`);
      return (data.agents || []).map(mapAgent);
    },

    agent: async (_, { slug }) => {
      const { data } = await axios.get(`${SERVICES.marketplace}/agents/${slug}`);
      return mapAgent(data);
    },

    installations: async (_, { orgId }) => {
      const { data } = await axios.get(`${SERVICES.marketplace}/installations/${orgId}`);
      return (data.installations || []).map(i => ({
        id: i.id, agentId: i.agent_id, orgId: i.org_id,
        installedVersion: i.installed_version, isActive: i.is_active,
        installedAt: i.installed_at,
        agent: {
          id: i.agent_id || i.ad_id,
          name: i.name, slug: i.slug, version: i.installed_version,
          category: i.category, description: i.description || '',
          publisherType: i.publisher_type, agentType: i.agent_type,
          requiredPermissions: i.required_permissions || [],
          declaredTools: i.declared_tools || [],
          isVerified: true, isPublished: true,
          flowDefinition: null, agentPurpose: i.agent_purpose,
          publisherOrgId: i.publisher_org_id || null,
        },
      }));
    },

    agentRuns: async (_, { studyId, limit = 50 }) => {
      const { data } = await axios.get(`${SERVICES.agentRuntime}/runs?study_id=${studyId}&limit=${limit}`);
      return (data.runs || []).map(mapRun);
    },

    agentRun: async (_, { runId }) => {
      const { data } = await axios.get(`${SERVICES.agentRuntime}/runs/${runId}`);
      return mapRun(data);
    },

    agentRunDetail: async (_, { runId }) => {
      const { data } = await axios.get(`${SERVICES.agentRuntime}/runs/${runId}`);
      const run = mapRunDetail(data);
      try {
        const { data: evalData } = await axios.get(
          `${SERVICES.agentRuntime}/runs/${runId}/evaluation`
        );
        if (evalData && evalData.id) run.evaluation = mapEvaluation(evalData);
      } catch (_) {}
      return run;
    },

    agentRunsForSession: async (_, { sessionId }) => {
      const { data } = await axios.get(
        `${SERVICES.agentRuntime}/runs/session/${sessionId}`
      );
      return (data.runs || []).map(mapRunDetail);
    },

    mappingCheckpoint: async (_, { runId }) => {
      const { data } = await axios.get(`${SERVICES.agentRuntime}/runs/${runId}/checkpoint`);
      return {
        runId: data.run_id, status: data.status,
        checkpointData: data.checkpoint_data,
        approval: data.approval, stepTraces: data.step_traces,
      };
    },

    agentRunsForOrg: async (_, { orgId, limit = 50 }) => {
      const { data } = await axios.get(`${SERVICES.agentRuntime}/runs/org/${orgId}?limit=${limit}`);
      return (data.runs || []).map(mapRunDetail);
    },

    approvalRequests: async (_, { studyId, status = 'pending' }) => {
      const { data } = await axios.get(`${SERVICES.agentRuntime}/approvals/${studyId}?status=${status}`);
      return (data.approvals || []).map(a => ({
        id: a.id, runId: a.run_id, orgId: a.org_id, studyId: a.study_id,
        title: a.title, description: a.description,
        proposedAction: a.proposed_action, status: a.status, createdAt: a.created_at,
      }));
    },

    approvalRequest: async (_, { id }) => {
      const { data } = await axios.get(`${SERVICES.agentRuntime}/approvals/by-id/${id}`);
      return {
        id: data.id, runId: data.run_id, orgId: data.org_id, studyId: data.study_id,
        title: data.title, description: data.description,
        proposedAction: data.proposed_action, status: data.status, createdAt: data.created_at,
      };
    },

    sdtmMappingTasks: async (_, { orgId, status = 'pending' }) => {
      try {
        const { data } = await axios.get(`${SERVICES.agentRuntime}/approvals/org/${orgId}?status=${status}`);
        return (data.approvals || [])
          .filter(a => a.proposed_action?.domains)  // SDTM approvals have domains; USDM have study
          .map(a => ({
            id: a.id, runId: a.run_id, orgId: a.org_id, studyId: a.study_id,
            title: a.title, description: a.description, status: a.status, createdAt: a.created_at,
          }));
      } catch (e) {
        return [];
      }
    },

    usdmMappingTasks: async (_, { orgId }) => {
      try {
        const { data: convs } = await axios.get(`${SERVICES.agentRuntime}/usdm?org_id=${orgId}`);

        // Tasks waiting for document upload (selecting_document)
        const selectDocTasks = (convs || [])
          .filter(c => c.status === 'selecting_document')
          .map(c => ({
            id: c.approval_id || c.id,
            conversionId: c.id,
            runId: c.run_id || '',
            orgId: c.org_id,
            studyId: c.study_id || null,
            name: c.name,
            title: `Upload Protocol Document — ${c.name}`,
            description: 'Select or upload the protocol document to begin USDM v4 conversion.',
            status: 'pending',
            taskType: 'select_document',
            createdAt: c.updated_at || c.created_at,
          }));

        // Tasks waiting for USDM review/approval
        const reviewTasks = (convs || [])
          .filter(c => c.status === 'waiting_approval' && c.approval_id)
          .map(c => ({
            id: c.approval_id,
            conversionId: c.id,
            runId: c.run_id || '',
            orgId: c.org_id,
            studyId: c.study_id || null,
            name: c.name,
            title: `Review USDM Mapping — ${c.name}`,
            description: `Protocol: ${c.protocol_filename}`,
            status: 'pending',
            taskType: 'review_mapping',
            createdAt: c.updated_at || c.created_at,
          }));

        // Fallback: pending approval_requests without a usdm_conversions record
        const knownApprovalIds = new Set([...selectDocTasks, ...reviewTasks].map(t => t.id));
        const { data: appData } = await axios.get(`${SERVICES.agentRuntime}/approvals/org/${orgId}?status=pending`);
        const fromApprovals = (appData.approvals || [])
          .filter(a => !knownApprovalIds.has(a.id))
          .filter(a => a.proposed_action?.type === 'select_document' || a.proposed_action?.conversion_id)
          .map(a => {
            const isSelectDoc = a.proposed_action?.type === 'select_document';
            const convId = a.proposed_action?.conversion_id || a.id;
            return {
              id: a.id,
              conversionId: convId,
              runId: a.run_id || '',
              orgId: a.org_id,
              studyId: a.study_id || null,
              name: a.proposed_action?.study_name || a.title?.replace(/^(Upload Protocol Document|Review USDM[^—]*) — /, '') || 'USDM',
              title: a.title || (isSelectDoc ? 'Upload Protocol Document' : 'Review USDM Mapping'),
              description: a.description || '',
              status: 'pending',
              taskType: isSelectDoc ? 'select_document' : 'review_mapping',
              createdAt: a.created_at,
            };
          });

        return [...selectDocTasks, ...reviewTasks, ...fromApprovals];
      } catch (e) {
        return [];
      }
    },

    auditEvents: async (_, args) => {
      const mapEvent = e => ({
        eventId: e.event_id, orgId: e.org_id, studyId: e.study_id,
        timestamp: e.timestamp, actorType: e.actor_type, actorId: e.actor_id,
        action: e.action, resourceType: e.resource_type, resourceId: e.resource_id,
        beforeState: e.before_state, afterState: e.after_state,
        metadata: e.metadata, rowHash: e.row_hash, prevHash: e.prev_hash,
        ipAddress: e.ip_address, sessionId: e.session_id,
        isTestRun: e.is_test_run || false,
      });

      if (args.runId) {
        // Fetch events both where the run is the resource AND where it acted as the actor
        // (data.intake, context.retrieval, artifact.generated use a file-specific resource_id
        //  but set actor_id=run_id — we need both to get the full audit trail)
        const limit = args.limit || 200;
        const queries = [
          axios.get(`${SERVICES.audit}/events?resource_id=${args.runId}&limit=${limit}`),
        ];
        // Also query by actor_id=runId (requires org_id per audit service rules)
        if (args.orgId) {
          queries.push(
            axios.get(`${SERVICES.audit}/events?actor_id=${args.runId}&org_id=${args.orgId}&limit=${limit}`)
              .catch(() => ({ data: { events: [] } }))
          );
        }
        const results = await Promise.all(queries);
        const allEvents = results.flatMap(r => r.data.events || []);
        // Deduplicate by event_id
        const seen = new Set();
        const deduped = allEvents.filter(e => {
          const key = e.event_id || e.id;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        // Sort chronologically
        deduped.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        return deduped.map(mapEvent);
      }

      // Non-runId query path (audit log page, etc.)
      const params = new URLSearchParams();
      if (args.orgId) params.set('org_id', args.orgId);
      if (args.studyId) params.set('study_id', args.studyId);
      if (args.actorId) params.set('actor_id', args.actorId);
      if (args.action) params.set('action', args.action);
      if (args.resourceType) params.set('resource_type', args.resourceType);
      if (args.resourceId) params.set('resource_id', args.resourceId);
      if (args.fromTs) params.set('from_ts', args.fromTs);
      if (args.toTs) params.set('to_ts', args.toTs);
      if (args.limit) params.set('limit', String(args.limit));
      if (args.offset) params.set('offset', String(args.offset));
      const { data } = await axios.get(`${SERVICES.audit}/events?${params}`);
      return (data.events || []).map(mapEvent);
    },

    verifyAuditChain: async (_, { orgId }) => {
      const { data } = await axios.post(`${SERVICES.audit}/verify-chain?org_id=${orgId}`);
      return {
        orgId: data.org_id, totalEvents: data.total_events,
        chainValid: data.chain_valid, brokenLinks: data.broken_links,
      };
    },

    notifications: async (_, { userId, orgId, unreadOnly = false }) => {
      const params = new URLSearchParams({ org_id: orgId, unread_only: String(unreadOnly) });
      const { data } = await axios.get(`${SERVICES.notifications}/notifications/${userId}?${params}`);
      return (data.notifications || []).map(n => ({
        id: n.id, orgId: n.org_id, studyId: n.study_id, userId: n.user_id,
        notificationType: n.notification_type, severity: n.severity,
        title: n.title, body: n.body, readAt: n.read_at, createdAt: n.created_at,
      }));
    },

    documents: async (_, { orgId, studyId, documentType }) => {
      const params = new URLSearchParams({ org_id: orgId });
      if (studyId) params.set('study_id', studyId);
      if (documentType) params.set('document_type', documentType);
      const { data } = await axios.get(`${SERVICES.ingestion}/documents?${params}`);
      return (data.documents || []).map(d => ({
        id: d.id, name: d.name, documentType: d.document_type,
        version: d.version, status: d.status, sha256Hash: d.sha256_hash,
        fileSizeBytes: d.file_size_bytes, createdAt: d.created_at,
      }));
    },

    // ── Context graph queries ─────────────────────────────────────────────────
    queryContext: async (_, { orgId, query, studyId, topK = 8, includeLineage = false }) => {
      const { data } = await axios.post(`${SERVICES.contextGraph}/context/query`, {
        org_id: orgId, query, study_id: studyId, top_k: topK, include_lineage: includeLineage,
      });
      return {
        query: data.query,
        results: (data.results || []).map(r => ({
          text: r.text, score: r.score || 0, entityType: r.entity_type, entityKey: r.entity_key,
          nodeIds: r.node_ids || [],
        })),
        sourcesCited: (data.sources_cited || []).map(s => ({
          docName: s.doc_name, docType: s.doc_type, docId: s.doc_id,
          chunkId: s.chunk_id, nodeId: s.node_id, score: s.score || 0,
          section: s.section, excerpt: s.excerpt,
        })),
        searchMethod: data.search_method || 'unknown',
      };
    },

    // ── Scoped Retrieval Engine ───────────────────────────────────────────────
    retrievalQuery: async (_, { orgId, query, studyId, installationId, topK = 8, maxTokens = 4000 }) => {
      const { data } = await axios.post(`${SERVICES.contextGraph}/retrieval/query`, {
        org_id: orgId, query, study_id: studyId, installation_id: installationId,
        top_k: topK, max_tokens: maxTokens,
      });
      return {
        query: data.query, packHash: data.pack_hash, fromCache: data.from_cache,
        chunks: data.chunks || [], sourcesCited: data.sources_cited || [],
        scopeSummary: data.scope_summary || {}, searchMethod: data.search_method || 'retrieval_engine',
        tokenEstimate: data.token_estimate || 0,
      };
    },

    // ── Indexing Drift ────────────────────────────────────────────────────────
    indexingDriftReport: async (_, { orgId }) => {
      const { data } = await axios.get(`${SERVICES.contextGraph}/graph/drift-report?org_id=${orgId}`);
      return (data.documents || []).map(d => ({
        documentId: d.document_id, documentName: d.document_name,
        indexedChunksCount: d.indexed_chunks_count, totalChunksCount: d.total_chunks_count,
        driftScore: d.drift_score, needsReindex: d.needs_reindex,
        lastCheckedAt: d.last_checked_at,
      }));
    },

    // ── Decision Trace Graph (audit) ──────────────────────────────────────────
    decisionTraceGraph: async (_, { runId, orgId }) => {
      const { data } = await axios.get(
        `${SERVICES.contextGraph}/traces/${runId}/graph?org_id=${orgId}`);
      return data;  // returns {run_id, nodes, edges} as JSON
    },

    // ── Context Pack Log ──────────────────────────────────────────────────────
    contextPackLog: async (_, { orgId, studyId, limit = 20 }) => {
      const { data } = await axios.get(`${SERVICES.contextGraph}/graph/pack-log`, {
        params: { org_id: orgId, study_id: studyId, limit },
      });
      return (data.packs || []).map(p => ({
        id: p.id, packHash: p.pack_hash, queryText: p.query_text,
        tokenCount: p.token_count, cacheHit: p.cache_hit, createdAt: p.created_at,
      }));
    },

    pendingClassifications: async (_, { orgId }) => {
      const { data } = await axios.get(`${SERVICES.contextGraph}/classify/pending?org_id=${orgId}`);
      return (data.pending || []).map(p => ({
        id: p.id, documentId: p.document_id, fileName: p.file_name,
        suggestedTypeCodes: p.suggested_type_codes || [],
        confidenceScores: p.confidence_scores,
        llmAnalysis: p.llm_analysis, metadataExtracted: p.metadata_extracted,
        createdAt: p.created_at,
      }));
    },

    decisionTraces: async (_, { runId }) => {
      const { data } = await axios.get(`${SERVICES.contextGraph}/traces/${runId}`);
      return (data.traces || []).map(mapDecisionTrace);
    },

    documentTypes: async (_, { orgId }) => {
      const { data } = await axios.get(`${SERVICES.contextGraph}/document-types?org_id=${orgId}`);
      return (data.types || []).map(t => ({
        typeCode: t.type_code, typeName: t.type_name,
        description: t.description, isSystem: t.is_system,
      }));
    },

    contextLineage: async (_, { nodeId, depth = 4 }) => {
      const { data } = await axios.get(`${SERVICES.contextGraph}/lineage/${nodeId}?depth=${depth}`);
      return data;
    },

    // ── Neo4j Reasoning Graph ─────────────────────────────────────────────────
    agentRunGraph: async (_, { runId, orgId }) => {
      try {
        const { data } = await axios.get(
          `${SERVICES.contextGraph}/graph/run/${runId}?org_id=${orgId}`
        );
        return { nodes: data.nodes || [], edges: data.edges || [], runId: data.run_id || runId };
      } catch (_) {
        return { nodes: [], edges: [], runId };
      }
    },

    // ── ACP: Apps ─────────────────────────────────────────────────────────────
    apps: async (_, { orgId, status, category }) => {
      const params = new URLSearchParams({ org_id: orgId });
      if (status) params.set('status', status);
      if (category) params.set('category', category);
      const { data } = await axios.get(`${SERVICES.appComposer}/apps?${params}`);
      return (data.apps || []).map(mapApp);
    },

    app: async (_, { id, orgId }) => {
      const params = orgId ? `?org_id=${orgId}` : '';
      const { data } = await axios.get(`${SERVICES.appComposer}/apps/${id}${params}`);
      return mapApp(data);
    },

    appCatalog: async () => {
      const { data } = await axios.get(`${SERVICES.appComposer}/catalog`);
      return (data.apps || []).map(mapApp);
    },

    appVersions: async (_, { appId }) => {
      const { data } = await axios.get(`${SERVICES.appComposer}/apps/${appId}/versions`);
      return (data.versions || []).map(v => ({
        id: v.id, appId: v.app_id, version: v.version, status: v.status,
        changeType: v.change_type, changeReason: v.change_reason,
        changedBy: v.changed_by, name: v.name, description: v.description,
        createdAt: v.created_at,
      }));
    },

    appInstallations: async (_, { orgId }) => {
      const { data } = await axios.get(`${SERVICES.appComposer}/installs?org_id=${orgId}`);
      return (data.installations || []).map(mapInstallation);
    },

    // ── ACP: Workflows ────────────────────────────────────────────────────────
    workflowInstances: async (_, { orgId, status, appId, studyId, limit = 50 }) => {
      const params = new URLSearchParams({ org_id: orgId });
      if (status) params.set('status', status);
      if (appId) params.set('app_id', appId);
      if (studyId) params.set('study_id', studyId);
      params.set('limit', String(limit));
      const { data } = await axios.get(`${SERVICES.workflowBridge}/instances?${params}`);
      return (data.instances || []).map(mapWorkflowInstance);
    },

    workflowInstance: async (_, { id }, context) => {
      const auth = context.token ? { headers: { Authorization: context.token } } : {};
      const { data } = await axios.get(`${SERVICES.workflowBridge}/instances/${id}`, auth);
      return mapWorkflowInstance(data);
    },

    workflowTask: async (_, { id }, context) => {
      const auth = context.token ? { headers: { Authorization: context.token } } : {};
      const { data } = await axios.get(`${SERVICES.workflowBridge}/tasks/${id}`, auth);
      return mapTask(data);
    },

    workflowTasks: async (_, { orgId, status, assigneeId, limit = 50 }) => {
      const params = new URLSearchParams({ org_id: orgId });
      if (status) params.set('status', status);
      if (assigneeId) params.set('assignee_id', assigneeId);
      params.set('limit', String(limit));
      const { data } = await axios.get(`${SERVICES.workflowBridge}/tasks?${params}`);
      return (data.tasks || []).map(mapTask);
    },

    myTasks: async (_, { orgId, userId }, context) => {
      const auth = context.token ? { headers: { Authorization: context.token } } : {};
      const { data } = await axios.get(`${SERVICES.workflowBridge}/tasks/my?org_id=${orgId}&user_id=${userId}`, auth);
      return (data.tasks || []).map(mapTask);
    },

    // ── ACP: Forms ────────────────────────────────────────────────────────────
    forms: async (_, { orgId, appId, status }) => {
      const params = new URLSearchParams({ org_id: orgId });
      if (appId) params.set('app_id', appId);
      if (status) params.set('status', status);
      const { data } = await axios.get(`${SERVICES.formEngine}/forms?${params}`);
      return (data.forms || []).map(mapForm);
    },

    formSchema: async (_, { formId }) => {
      const { data } = await axios.get(`${SERVICES.formEngine}/forms/${formId}`);
      return mapForm(data);
    },

    formSubmissions: async (_, { orgId, formId }) => {
      const { data } = await axios.get(`${SERVICES.formEngine}/forms/${formId}/submissions?org_id=${orgId}`);
      return (data.submissions || []).map(mapSubmission);
    },

    electronicSignatures: async (_, { orgId, resourceId }) => {
      const { data } = await axios.get(`${SERVICES.appComposer}/apps/${resourceId}/signatures?org_id=${orgId}`);
      return (data.signatures || []).map(mapEsig);
    },

    // ── Widget / Dashboard queries ─────────────────────────────────────
    widgets: async (_, { orgId, studyId }) => {
      const params = new URLSearchParams({ org_id: orgId });
      if (studyId) params.set('study_id', studyId);
      const { data } = await axios.get(`${SERVICES.agentRuntime}/widgets?${params}`);
      return data.widgets || [];
    },

    widget: async (_, { id }) => {
      const { data } = await axios.get(`${SERVICES.agentRuntime}/widgets/${id}`);
      return data;
    },

    dashboards: async (_, { orgId, studyId }) => {
      const params = new URLSearchParams({ org_id: orgId });
      if (studyId) params.set('study_id', studyId);
      const { data } = await axios.get(`${SERVICES.agentRuntime}/dashboards?${params}`);
      return data.dashboards || [];
    },

    dashboard: async (_, { id }) => {
      const { data } = await axios.get(`${SERVICES.agentRuntime}/dashboards/${id}`);
      return data;
    },

    usdmConversions: async (_, { orgId, studyId }) => {
      const params = new URLSearchParams({ org_id: orgId });
      if (studyId) params.set('study_id', studyId);
      const { data } = await axios.get(`${SERVICES.agentRuntime}/usdm?${params}`);
      return (data || []).map(c => ({
        id: c.id, orgId: c.org_id, studyId: c.study_id,
        protocolDocId: c.protocol_doc_id, protocolFilename: c.protocol_filename,
        protocolS3Key: c.protocol_s3_key, name: c.name, status: c.status,
        usdmJson: c.usdm_json, runId: c.run_id, approvalId: c.approval_id,
        createdBy: c.created_by, errorMessage: c.error_message,
        createdAt: c.created_at, updatedAt: c.updated_at,
      }));
    },

    usdmConversion: async (_, { id }) => {
      // First try looking up by conversion id
      try {
        const { data } = await axios.get(`${SERVICES.agentRuntime}/usdm/${id}`);
        // If usdmJson is empty but approvalId exists, load from approval proposedAction
        let usdmJson = data.usdm_json;
        if ((!usdmJson || Object.keys(usdmJson).length === 0) && data.approval_id) {
          try {
            const { data: apr } = await axios.get(`${SERVICES.agentRuntime}/approvals/by-id/${data.approval_id}`);
            if (apr?.proposed_action?.study) usdmJson = apr.proposed_action;
          } catch {}
        }
        return {
          id: data.id, orgId: data.org_id, studyId: data.study_id,
          protocolDocId: data.protocol_doc_id, protocolFilename: data.protocol_filename,
          protocolS3Key: data.protocol_s3_key, name: data.name, status: data.status,
          usdmJson, runId: data.run_id, approvalId: data.approval_id,
          createdBy: data.created_by, errorMessage: data.error_message,
          createdAt: data.created_at, updatedAt: data.updated_at,
        };
      } catch (e) {
        // Fallback: treat id as an approvalId (for runs without a usdm_conversions record)
        const { data: apr } = await axios.get(`${SERVICES.agentRuntime}/approvals/by-id/${id}`);
        return {
          id, orgId: apr.org_id, studyId: apr.study_id,
          protocolDocId: null,
          protocolFilename: apr.proposed_action?.protocolFilename || 'protocol.pdf',
          protocolS3Key: null,
          name: apr.title?.replace(/^Review USDM v4 Mapping — /, '') || 'USDM Mapping',
          status: 'waiting_approval',
          usdmJson: apr.proposed_action?.study ? apr.proposed_action : {},
          runId: apr.run_id, approvalId: apr.id,
          createdBy: null, errorMessage: null,
          createdAt: apr.created_at, updatedAt: apr.created_at,
        };
      }
    },

    validateProtocolDoc: async (_, { s3Key, filename }) => {
      try {
        const { data } = await axios.post(`${SERVICES.agentRuntime}/validate-protocol-doc`, {
          s3_key: s3Key, filename,
        });
        return {
          isValidProtocol: data.is_valid_protocol,
          confidence: data.confidence,
          matchedIndicators: data.matched_indicators || [],
          wordCount: data.word_count || null,
          error: data.error || null,
        };
      } catch (e) {
        return { isValidProtocol: false, confidence: 0, matchedIndicators: [], wordCount: null, error: e.message };
      }
    },

    // ── Evaluator queries ─────────────────────────────────────────────────
    evaluatorCatalog: async () => {
      try {
        const { data } = await axios.get(`${SERVICES.agentRuntime}/evaluators/catalog`);
        return (data.evaluators || []).map(mapEvaluatorDefinition);
      } catch (_) { return []; }
    },

    orgEvaluators: async (_, { orgId }) => {
      try {
        const { data } = await axios.get(`${SERVICES.agentRuntime}/evaluators`, { params: { org_id: orgId } });
        return (data.evaluators || []).map(mapEvaluatorDefinition);
      } catch (_) { return []; }
    },

    runEvaluatorResults: async (_, { runId }) => {
      try {
        const { data } = await axios.get(`${SERVICES.agentRuntime}/runs/${runId}/evaluator-results`);
        return (data.results || []).map(mapEvaluatorResult);
      } catch (_) { return []; }
    },

    agentEvaluatorStats: async (_, { agentName, orgId }) => {
      try {
        const { data } = await axios.get(`${SERVICES.agentRuntime}/agents/${encodeURIComponent(agentName)}/evaluator-stats`, {
          params: { org_id: orgId },
        });
        const stats = (data.stats || []).map(s => ({
          evaluatorId: s.evaluator_id,
          evaluatorName: s.evaluator_name,
          evaluatorSlug: s.evaluator_slug,
          evaluatorCategory: s.evaluator_category,
          evaluatorDescription: s.evaluator_description,
          isBuiltin: s.is_builtin ?? false,
          runCount: s.run_count ?? 0,
          avgScore: s.avg_score ?? null,
          minScore: s.min_score ?? null,
          maxScore: s.max_score ?? null,
          scoreStddev: s.score_stddev ?? null,
          passCount: s.pass_count ?? 0,
          failCount: s.fail_count ?? 0,
          partialCount: s.partial_count ?? 0,
          unknownCount: s.unknown_count ?? 0,
          passRate: s.pass_rate ?? null,
          failRate: s.fail_rate ?? null,
          lastEvaluatedAt: s.last_evaluated_at ?? null,
          firstEvaluatedAt: s.first_evaluated_at ?? null,
          provenanceNarrative: s.provenance_narrative ?? null,
          scoringDimensions: s.scoring_dimensions ?? [],
          trend: (s.trend || []).map(t => ({ day: t.day, avgScore: t.avg_score, count: t.count })),
          recentResults: (s.recent_results || []).map(r => ({
            id: r.id, runId: r.run_id, score: r.score, verdict: r.verdict,
            notes: r.notes, details: r.details, judgeModel: r.judge_model,
            triggeredBy: r.triggered_by, createdAt: r.created_at,
            runStatus: r.run_status, runStartedAt: r.run_started_at,
          })),
        }));
        return {
          agentName: data.agent_name,
          orgId: data.org_id,
          totalEvaluations: data.total_evaluations ?? 0,
          evaluatorCount: data.evaluator_count ?? 0,
          stats,
        };
      } catch (e) {
        return { agentName, orgId, totalEvaluations: 0, evaluatorCount: 0, stats: [] };
      }
    },

    testDataDomains: async () => {
      try {
        const { data } = await axios.get(`${SERVICES.agentRuntime}/generate-test-data/domains`);
        return {
          SDTM: data.SDTM || [],
          ADaM: data.ADaM || [],
          CRF: data.CRF || [],
          RawEDC: data.RawEDC || [],
          Protocol: data.Protocol || [],
          TLF: data.TLF || [],
        };
      } catch (e) {
        return {
          SDTM: ['DM','AE','LB','VS','CM','EX','MH','DS','SV'],
          ADaM: ['ADSL','ADAE','ADLB','ADVS','ADCM','ADTTE'],
          CRF: ['AE','DM','CM','LB','VS','MH','DS','EX','SV','QS'],
          RawEDC: ['AE','DM','CM','LB','VS','MH','DS','EX','SV','QS'],
          Protocol: ['TITLE','OBJECTIVES','DESIGN','POPULATION','ENDPOINTS','PROCEDURES','STATISTICS'],
          TLF: ['TABLES','LISTINGS','FIGURES'],
        };
      }
    },
  },

  Mutation: {
    installAgent: async (_, { orgId, agentId, installedBy, consentedPermissions }) => {
      const { data } = await axios.post(`${SERVICES.marketplace}/agents/install`, {
        org_id: orgId, agent_id: agentId,
        installed_by: installedBy, consented_permissions: consentedPermissions,
      });
      return { id: data.installation_id, agentId, orgId, installedVersion: data.version, isActive: true, installedAt: new Date().toISOString() };
    },

    createUIAgent: async (_, { input }) => {
      const { data } = await axios.post(`${SERVICES.marketplace}/agents/create-ui`, {
        org_id: input.orgId, created_by: input.createdBy,
        name: input.name, description: input.description, category: input.category,
        agent_type: input.agentType || 'config-driven',
        trigger_type: input.triggerType, trigger_config: input.triggerConfig,
        data_scope: input.dataScope, declared_tools: input.declaredTools,
        system_prompt: input.systemPrompt, objective: input.objective,
        output_format: input.outputFormat, actions: input.actions,
      });
      return { id: data.agent_id, name: input.name, slug: data.slug, version: '1.0.0',
        category: input.category, description: input.description,
        publisherType: 'org-created', agentType: input.agentType || 'config-driven',
        requiredPermissions: [], declaredTools: input.declaredTools || [],
        isVerified: false, isPublished: true };
    },

    createFlowAgent: async (_, { input }) => {
      const { data } = await axios.post(`${SERVICES.marketplace}/agents/create-flow`, {
        org_id: input.orgId, created_by: input.createdBy,
        name: input.name, description: input.description, category: input.category,
        agent_purpose: input.agentPurpose || 'custom',
        data_sources: input.dataSources || [],
        flow_definition: input.flowDefinition,
        output_format: input.outputFormat || 'narrative',
      });
      return { id: data.agent_id, name: input.name, slug: data.slug, version: '1.0.0',
        category: input.category, description: input.description,
        publisherType: 'org-created', agentType: 'langchain-flow',
        requiredPermissions: [], declaredTools: data.declared_tools || [],
        isVerified: false, isPublished: true };
    },

    createTrigger: async (_, args) => {
      const { data } = await axios.post(`${SERVICES.marketplace}/triggers`, {
        installation_id: args.installationId, study_id: args.studyId,
        trigger_type: args.triggerType, trigger_config: args.triggerConfig,
        created_by: args.createdBy,
      });
      return data;
    },

    startAgentRun: async (_, { installationId, studyId, orgId, inputContext, isTestRun }) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/runs`, {
        installation_id: installationId, study_id: studyId,
        org_id: orgId, input_context: inputContext || {},
        is_test_run: isTestRun || false,
      });
      // POST /runs returns { run_id, status } only — backfill non-nullable fields from input args
      return mapRun({
        id: data.run_id,
        installation_id: installationId,
        study_id: studyId,
        status: data.status || 'pending',
        is_test_run: isTestRun || false,
        started_at: new Date().toISOString(),
      });
    },

    resumeAgentRun: async (_, { runId, approvalId, decision, modifiedSpec, decidedBy, note, restart }) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/runs/${runId}/resume`, {
        approval_id: approvalId, decision,
        modified_spec: modifiedSpec || null,
        decided_by: decidedBy, note: note || '',
        restart: restart || false,
      });
      return data;
    },

    decideApproval: async (_, { approvalId, decision, deciderId, note }) => {
      const { data } = await axios.patch(
        `${SERVICES.agentRuntime}/approvals/${approvalId}?decision=${decision}&decider_id=${deciderId}&note=${encodeURIComponent(note || '')}`,
      );
      return { id: approvalId, runId: '', orgId: '', title: '', description: '',
        proposedAction: {}, status: decision, createdAt: new Date().toISOString() };
    },

    writeAuditEvent: async (_, { input }) => {
      const { data } = await axios.post(`${SERVICES.audit}/events`, {
        org_id: input.orgId, study_id: input.studyId,
        actor_type: input.actorType, actor_id: input.actorId,
        action: input.action, resource_type: input.resourceType,
        resource_id: input.resourceId, before_state: input.beforeState,
        after_state: input.afterState, ip_address: input.ipAddress,
        session_id: input.sessionId, is_test_run: input.isTestRun,
      });
      return { eventId: data.event_id, orgId: data.org_id, studyId: data.study_id,
        timestamp: data.timestamp, actorType: data.actor_type, actorId: data.actor_id,
        action: data.action, resourceType: data.resource_type, resourceId: data.resource_id,
        rowHash: data.row_hash, prevHash: data.prev_hash };
    },

    markNotificationRead: async (_, { notificationId }) => {
      await axios.patch(`${SERVICES.notifications}/notifications/${notificationId}/read`);
      return { id: notificationId, orgId: '', userId: '', notificationType: '',
        severity: 'info', title: '', body: '', createdAt: new Date().toISOString() };
    },

    setNotificationPreferences: async (_, { userId, orgId, notificationType, channels, enabled }) => {
      const { data } = await axios.put(`${SERVICES.notifications}/preferences`, {
        user_id: userId, org_id: orgId, notification_type: notificationType,
        channels, enabled,
      });
      return data;
    },

    // ── Context graph mutations ───────────────────────────────────────────────
    submitContextFeedback: async (_, { input }) => {
      const payload = buildSubmitContextFeedbackPayload(input);
      const { data } = await axios.post(`${SERVICES.contextGraph}/feedback`, payload);
      return data;
    },

    resolveDocumentClassification: async (_, { classificationId, resolvedType, resolvedBy }) => {
      const { data } = await axios.post(
        `${SERVICES.contextGraph}/classify/${classificationId}/resolve`,
        { resolved_type: resolvedType, resolved_by: resolvedBy }
      );
      return data;
    },

    createDocumentType: async (_, { input }) => {
      const { data } = await axios.post(`${SERVICES.contextGraph}/document-types`, {
        type_code: input.typeCode, type_name: input.typeName,
        description: input.description, org_id: input.orgId,
        detection_patterns: input.detectionPatterns || [],
        schema_hints: input.schemaHints || {},
      });
      return data;
    },

    // ── ACP Mutations ─────────────────────────────────────────────────────────
    createApp: async (_, { input }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.appComposer}/apps`, {
        org_id: input.orgId, name: input.name, slug: input.slug,
        description: input.description, category: input.category || 'clinical',
        bpmn_xml: input.bpmnXml, form_ids: input.formIds || [],
        agent_attachments: input.agentAttachments || [], settings: input.settings || {},
        created_by: input.createdBy,
      }, auth);
      return mapApp(data);
    },

    updateApp: async (_, { id, input }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.patch(`${SERVICES.appComposer}/apps/${id}`, {
        name: input.name, description: input.description, category: input.category,
        bpmn_xml: input.bpmnXml, workflow_definition: input.workflowDefinition,
        form_ids: input.formIds, agent_attachments: input.agentAttachments,
        settings: input.settings,
      }, auth);
      return mapApp(data);
    },

    publishApp: async (_, { appId }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.appComposer}/apps/${appId}/publish`, {}, auth);
      return mapApp(data);
    },

    installApp: async (_, { appId, orgId, consentedPermissions, customConfig }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.appComposer}/apps/${appId}/install`, {
        org_id: orgId, consented_permissions: consentedPermissions || [],
        custom_config: customConfig || {},
      }, auth);
      return mapInstallation(data);
    },

    submitAppForReview: async (_, { appId }, context) => {
      const auth = { headers: { Authorization: context.token } };
      await axios.post(`${SERVICES.appComposer}/apps/${appId}/submit-for-review`, {}, auth);
      const { data } = await axios.get(`${SERVICES.appComposer}/apps/${appId}`);
      return mapApp(data);
    },

    startWorkflow: async (_, { input }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.workflowBridge}/instances`, {
        org_id: input.orgId, installation_id: input.installationId,
        app_id: input.appId, study_id: input.studyId,
        bpmn_process_id: input.bpmnProcessId,
        input_variables: input.inputVariables || {},
        sla_deadline: input.slaDeadline || null,
        started_by: input.startedBy,
      }, auth);
      return mapWorkflowInstance(data);
    },

    terminateWorkflow: async (_, { instanceId }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.delete(`${SERVICES.workflowBridge}/instances/${instanceId}`, auth);
      return mapWorkflowInstance(data);
    },

    claimTask: async (_, { taskId }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.workflowBridge}/tasks/${taskId}/claim`, {}, auth);
      return mapTask(data);
    },

    completeTask: async (_, { taskId, completionData, esignatureId }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.workflowBridge}/tasks/${taskId}/complete`, {
        completion_data: completionData || {}, esignature_id: esignatureId,
      }, auth);
      return mapTask(data);
    },

    reassignTask: async (_, { taskId, newAssigneeId }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.workflowBridge}/tasks/${taskId}/reassign`, {
        new_assignee_id: newAssigneeId,
      }, auth);
      return mapTask(data);
    },

    createForm: async (_, { input }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.formEngine}/forms`, {
        org_id: input.orgId, title: input.title, description: input.description,
        json_schema: input.jsonSchema, ui_schema: input.uiSchema,
        conditional_logic: input.conditionalLogic || [], app_id: input.appId,
      }, auth);
      return mapForm(data);
    },

    submitForm: async (_, { formId, data: formData, workflowTaskId, instanceId }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.formEngine}/forms/${formId}/submit`, {
        data: formData, workflow_task_id: workflowTaskId, instance_id: instanceId,
      }, auth);
      return mapSubmission(data);
    },

    createElectronicSignature: async (_, { resourceType, resourceId, meaning, password }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.appComposer}/apps/${resourceId}/sign`, {
        resource_type: resourceType, resource_id: resourceId, meaning, password,
      }, auth);
      return mapEsig(data);
    },

    attachAgentToStep: async (_, { appId, stepId, agentDefId, triggerMode, triggerCondition }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.post(`${SERVICES.appComposer}/apps/${appId}/steps/${stepId}/attach`, {
        agent_def_id: agentDefId, trigger_mode: triggerMode || 'always',
        trigger_condition: triggerCondition,
      }, auth);
      return data;
    },

    detachAgentFromStep: async (_, { appId, stepId }, context) => {
      const auth = { headers: { Authorization: context.token } };
      const { data } = await axios.delete(`${SERVICES.appComposer}/apps/${appId}/steps/${stepId}/detach`, auth);
      return data;
    },

    // ── Widget / Dashboard mutations ───────────────────────────────────
    createWidget: async (_, args) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/widgets`, {
        org_id: args.orgId, study_id: args.studyId, name: args.name,
        description: args.description || '', chart_type: args.chartType,
        echarts_config: args.echartsConfig, data_source: args.dataSource || {},
        created_by: args.createdBy,
      });
      return data;
    },

    updateWidget: async (_, { id, ...fields }) => {
      const body = {};
      if (fields.name !== undefined) body.name = fields.name;
      if (fields.description !== undefined) body.description = fields.description;
      if (fields.chartType !== undefined) body.chart_type = fields.chartType;
      if (fields.echartsConfig !== undefined) body.echarts_config = fields.echartsConfig;
      if (fields.dataSource !== undefined) body.data_source = fields.dataSource;
      const { data } = await axios.patch(`${SERVICES.agentRuntime}/widgets/${id}`, body);
      return data;
    },

    deleteWidget: async (_, { id }) => {
      await axios.delete(`${SERVICES.agentRuntime}/widgets/${id}`);
      return true;
    },

    createDashboard: async (_, args) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/dashboards`, {
        org_id: args.orgId, study_id: args.studyId,
        name: args.name, created_by: args.createdBy,
      });
      return data;
    },

    addWidgetToDashboard: async (_, { dashboardId, widgetId, posX, posY, width, height }) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/dashboards/${dashboardId}/placements`, {
        widget_id: widgetId, pos_x: posX || 0, pos_y: posY || 0,
        width: width || 6, height: height || 4,
      });
      return data;
    },

    updateDashboardLayout: async (_, { dashboardId, placements }) => {
      await axios.put(`${SERVICES.agentRuntime}/dashboards/${dashboardId}/layout`, { placements });
      return true;
    },

    removeWidgetFromDashboard: async (_, { placementId }) => {
      await axios.delete(`${SERVICES.agentRuntime}/dashboards/placements/${placementId}`);
      return true;
    },

    chatWithWidget: async (_, { widgetId, orgId, message, currentOptions }) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/widgets/${widgetId}/chat`, {
        org_id: orgId, message, current_options: currentOptions || null,
      });
      return { message: data.message, optionPatch: data.option_patch || null };
    },

    createUsdmDraft: async (_, { orgId, studyId, name, createdBy }) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/usdm/draft`, {
        org_id: orgId, study_id: studyId || null, name, created_by: createdBy || null,
      });
      return {
        id: data.conversion_id, orgId, studyId: studyId || null,
        protocolDocId: null, protocolFilename: null, protocolS3Key: null,
        name, status: 'selecting_document',
        usdmJson: null, runId: null, approvalId: null,
        createdBy: createdBy || null, errorMessage: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
    },

    beginUsdmConversion: async (_, { id, protocolDocId, protocolFilename, protocolS3Key, createdBy }) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/usdm/${id}/start`, {
        protocol_doc_id: protocolDocId, protocol_filename: protocolFilename,
        protocol_s3_key: protocolS3Key, created_by: createdBy || null,
      });
      return {
        id, orgId: null, studyId: null,
        protocolDocId, protocolFilename, protocolS3Key,
        name: null, status: 'pending',
        usdmJson: null, runId: data.run_id, approvalId: null,
        createdBy: createdBy || null, errorMessage: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
    },

    startUsdmConversion: async (_, { orgId, studyId, protocolDocId, protocolFilename, protocolS3Key, name, createdBy }) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/usdm`, {
        org_id: orgId, study_id: studyId || null,
        protocol_doc_id: protocolDocId, protocol_filename: protocolFilename,
        protocol_s3_key: protocolS3Key, name, created_by: createdBy || null,
      });
      // Return a minimal UsdmConversion object (full record fetched on refresh)
      return {
        id: data.conversion_id, orgId, studyId: studyId || null,
        protocolDocId, protocolFilename, protocolS3Key, name, status: 'pending',
        usdmJson: null, runId: data.run_id, approvalId: null,
        createdBy: createdBy || null, errorMessage: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
    },

    updateUsdmConversion: async (_, { id, usdmJson }) => {
      const { data } = await axios.patch(`${SERVICES.agentRuntime}/usdm/${id}`, { usdm_json: usdmJson });
      const conv = await axios.get(`${SERVICES.agentRuntime}/usdm/${id}`);
      const c = conv.data;
      return {
        id: c.id, orgId: c.org_id, studyId: c.study_id,
        protocolDocId: c.protocol_doc_id, protocolFilename: c.protocol_filename,
        protocolS3Key: c.protocol_s3_key, name: c.name, status: c.status,
        usdmJson: c.usdm_json, runId: c.run_id, approvalId: c.approval_id,
        createdBy: c.created_by, errorMessage: c.error_message,
        createdAt: c.created_at, updatedAt: c.updated_at,
      };
    },

    // ── Evaluator mutations ────────────────────────────────────────────────
    triggerEvaluator: async (_, { runId, evaluatorId, orgId, triggeredBy }) => {
      const { data } = await axios.post(
        `${SERVICES.agentRuntime}/runs/${runId}/evaluate/${evaluatorId}`,
        null,
        { params: { org_id: orgId, triggered_by: triggeredBy || 'user' } }
      );
      return mapEvaluatorResult(data);
    },

    saveEvaluator: async (_, { input }) => {
      const { data } = await axios.post(`${SERVICES.agentRuntime}/evaluators`, {
        org_id: input.orgId,
        name: input.name,
        slug: input.slug,
        description: input.description || '',
        category: input.category || 'custom',
        evaluator_type: input.evaluatorType,
        config: input.config || {},
        langfuse_score_name: input.langfuseScoreName || input.slug,
        created_by: input.createdBy || '',
      });
      const catalog = await axios.get(`${SERVICES.agentRuntime}/evaluators/catalog`);
      const ev = (catalog.data.evaluators || []).find(e => e.id === data.evaluator_id);
      if (ev) return mapEvaluatorDefinition(ev);
      return { id: data.evaluator_id, ...input, isBuiltin: false, isActive: true, config: input.config || {} };
    },

    updateEvaluator: async (_, { id, input }) => {
      const { data } = await axios.patch(`${SERVICES.agentRuntime}/evaluators/${id}`, {
        name: input.name,
        description: input.description,
        category: input.category,
        evaluator_type: input.evaluatorType,
        config: input.config,
        langfuse_score_name: input.langfuseScoreName,
        is_active: input.isActive,
      });
      return mapEvaluatorDefinition(data);
    },

    deleteEvaluator: async (_, { id }) => {
      try {
        await axios.delete(`${SERVICES.agentRuntime}/evaluators/${id}`);
        return true;
      } catch (_) { return false; }
    },

    generateTestData: async (_, { input }) => {
      const { dataType, subDomains, outputFormat, numRows, addAnomalies, studyId } = input;
      // Returns metadata; frontend downloads binary directly from agent-runtime REST endpoint
      const ext = { CSV: 'zip', XLS: 'xlsx', XPT: 'zip', PDF: 'pdf' }[outputFormat] || 'bin';
      return {
        downloadUrl: `${SERVICES.agentRuntime}/generate-test-data`,
        filename: `${(dataType || 'data').toLowerCase()}_test_data.${ext}`,
        mimeType: { CSV: 'application/zip', XLS: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XPT: 'application/zip', PDF: 'application/pdf' }[outputFormat] || 'application/octet-stream',
        rowsGenerated: numRows || 100,
        domains: subDomains || [],
      };
    },
  },

  // ── ACP Resolvers ─────────────────────────────────────────────────────────────

  // These extend the Query and Mutation resolvers above.
  // Note: extend type resolvers must be merged into existing Query/Mutation resolver maps.
  // The resolvers below are added via the extended types defined in typeDefs.

  Subscription: {
    agentRunUpdated: {
      subscribe: async function* (_, { studyId }) {
        // In production: subscribe to Kafka topic and yield updates
        // Placeholder: poll every 5 seconds
        while (true) {
          await new Promise(r => setTimeout(r, 5000));
          yield { agentRunUpdated: { id: 'poll', studyId, status: 'polling', createdAt: new Date().toISOString() } };
        }
      },
    },
    approvalRequested: {
      subscribe: async function* (_, { orgId }) {
        while (true) {
          await new Promise(r => setTimeout(r, 10000));
          yield { approvalRequested: { id: 'poll', orgId, runId: '', title: '', description: '', proposedAction: {}, status: 'pending', createdAt: new Date().toISOString() } };
        }
      },
    },
    notificationReceived: {
      subscribe: async function* (_, { userId }) {
        while (true) {
          await new Promise(r => setTimeout(r, 10000));
          yield { notificationReceived: { id: 'poll', userId, orgId: '', notificationType: '', severity: 'info', title: '', body: '', createdAt: new Date().toISOString() } };
        }
      },
    },
    workflowInstanceUpdated: {
      subscribe: async function* (_, { orgId }) {
        while (true) {
          await new Promise(r => setTimeout(r, 5000));
          yield { workflowInstanceUpdated: { id: 'poll', orgId, status: 'polling', startedAt: new Date().toISOString() } };
        }
      },
    },
    taskAssigned: {
      subscribe: async function* (_, { userId }) {
        while (true) {
          await new Promise(r => setTimeout(r, 10000));
          yield { taskAssigned: { id: 'poll', orgId: '', instanceId: '', status: 'pending', createdAt: new Date().toISOString() } };
        }
      },
    },
    appInstallationStatus: {
      subscribe: async function* (_, { orgId }) {
        while (true) {
          await new Promise(r => setTimeout(r, 10000));
          yield { appInstallationStatus: { id: 'poll', orgId, appId: '', installedVersion: '', status: 'active', installedAt: new Date().toISOString() } };
        }
      },
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapAgent(a) {
  return {
    id: a.id, name: a.name, slug: a.slug, version: a.version,
    category: a.category, description: a.description,
    publisherType: a.publisher_type, agentType: a.agent_type,
    requiredPermissions: a.required_permissions || [],
    declaredTools: a.declared_tools || [],
    isVerified: a.is_verified, isPublished: a.is_published,
    flowDefinition: a.flow_definition || null,
    agentPurpose: a.agent_purpose || null,
    publisherOrgId: a.publisher_org_id || null,
  };
}

function mapRun(r) {
  return {
    id: r.id || r.run_id,
    installationId: r.installation_id, studyId: r.study_id,
    status: r.status, isTestRun: r.is_test_run,
    startedAt: r.started_at, completedAt: r.completed_at,
    outputSummary: r.output_summary, tokensUsed: r.tokens_used,
    llmModel: r.llm_model, errorMessage: r.error_message, createdAt: r.created_at,
  };
}

function mapRunDetail(r) {
  const latencyMs = r.started_at && r.completed_at
    ? Math.round(new Date(r.completed_at) - new Date(r.started_at))
    : null;
  return {
    id: r.id, installationId: r.installation_id, studyId: r.study_id,
    status: r.status, agentName: r.agent_name, agentType: r.agent_type,
    agentSlug: r.agent_slug, llmModel: r.llm_model, tokensUsed: r.tokens_used,
    stepTraces: r.step_traces, checkpointData: r.checkpoint_data,
    artifacts: r.artifacts, outputSummary: r.output_summary,
    errorMessage: r.error_message,
    startedAt: r.started_at, completedAt: r.completed_at, createdAt: r.created_at,
    sessionId: r.session_id,
    latencyMs,
    costUsd: r.tokens_used ? parseFloat((r.tokens_used * 0.0000001).toFixed(8)) : 0,
    turnCount: r.turn_count || 0,
    toolCallsTotal: r.tool_calls_total || 0,
    toolCallsSuccessful: r.tool_calls_successful || 0,
  };
}

function mapEvaluation(e) {
  if (!e) return null;
  return {
    id: e.id, runId: e.run_id, sessionId: e.session_id,
    taskCompleted: e.task_completed, latencyMs: e.latency_ms, costUsd: e.cost_usd,
    toolCallsTotal: e.tool_calls_total, toolCallsSuccessful: e.tool_calls_successful,
    toolUsageAccuracy: e.tool_usage_accuracy,
    faithfulnessScore: e.faithfulness_score, reasoningScore: e.reasoning_score,
    hallucinationDetected: e.hallucination_detected, hallucinationRate: e.hallucination_rate,
    judgeModel: e.judge_model, judgeVerdict: e.judge_verdict, judgeNotes: e.judge_notes,
    evaluator: e.evaluator, evaluatedAt: e.evaluated_at,
  };
}

// ── ACP Mappers ───────────────────────────────────────────────────────────────

function mapApp(a) {
  if (!a) return null;
  return {
    id: a.id, orgId: a.org_id, name: a.name, slug: a.slug, version: a.version,
    description: a.description, category: a.category,
    bpmnXml: a.bpmn_xml, workflowDefinition: a.workflow_definition,
    formIds: a.form_ids, agentAttachments: a.agent_attachments,
    settings: a.settings, status: a.status, isPublished: a.is_published,
    publisherOrgId: a.publisher_org_id, createdBy: a.created_by,
    createdAt: a.created_at, updatedAt: a.updated_at,
  };
}

function mapInstallation(i) {
  if (!i) return null;
  return {
    id: i.id, orgId: i.org_id, appId: i.app_id,
    installedVersion: i.installed_version, installedBy: i.installed_by,
    zeebeDeploymentKey: i.zeebe_deployment_key ? String(i.zeebe_deployment_key) : null,
    customConfig: i.custom_config, status: i.status, installedAt: i.installed_at,
    app: i.app_name ? { id: i.app_id, name: i.app_name, description: i.description, category: i.category, slug: i.slug, bpmnXml: i.app_bpmn_xml || null } : null,
  };
}

function mapWorkflowInstance(w) {
  if (!w) return null;
  return {
    id: w.id, orgId: w.org_id, installationId: w.installation_id,
    appId: w.app_id, studyId: w.study_id,
    zeebeInstanceKey: w.zeebe_instance_key ? String(w.zeebe_instance_key) : null,
    bpmnProcessId: w.bpmn_process_id, status: w.status,
    inputVariables: w.input_variables, outputVariables: w.output_variables,
    slaDeadline: w.sla_deadline, startedAt: w.started_at, completedAt: w.completed_at,
  };
}

function mapTask(t) {
  if (!t) return null;
  return {
    id: t.id, orgId: t.org_id, instanceId: t.instance_id,
    zeebeJobKey: t.zeebe_job_key ? String(t.zeebe_job_key) : null,
    elementId: t.element_id, elementName: t.element_name,
    formId: t.form_id, assigneeId: t.assignee_id, assigneeRole: t.assignee_role,
    status: t.status, dueDate: t.due_date, claimedAt: t.claimed_at,
    completedAt: t.completed_at, completionData: t.completion_data,
    esignatureId: t.esignature_id, isOverdue: t.is_overdue || false,
    createdAt: t.created_at,
    variables: t.variables || null,
  };
}

function mapForm(f) {
  if (!f) return null;
  return {
    formId: f.form_id, orgId: f.org_id, appId: f.app_id,
    title: f.title, description: f.description,
    jsonSchema: f.json_schema, uiSchema: f.ui_schema,
    conditionalLogic: f.conditional_logic,
    version: f.version, status: f.status,
    createdAt: f.created_at, updatedAt: f.updated_at,
  };
}

function mapSubmission(s) {
  if (!s) return null;
  return {
    submissionId: s.submission_id, formId: s.form_id, orgId: s.org_id,
    workflowTaskId: s.workflow_task_id, instanceId: s.instance_id,
    submittedBy: s.submitted_by, data: s.data, status: s.status,
    esignatureId: s.esignature_id, submittedAt: s.submitted_at,
  };
}

function mapEsig(e) {
  if (!e) return null;
  return {
    id: e.id, orgId: e.org_id, resourceType: e.resource_type,
    resourceId: e.resource_id, signerId: e.signer_id,
    meaning: e.meaning, authMethod: e.auth_method,
    contentHash: e.content_hash, signedAt: e.signed_at,
  };
}

// ─── Server Bootstrap ─────────────────────────────────────────────────────────

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  const schema = makeExecutableSchema({ typeDefs, resolvers });

  // WebSocket server for subscriptions
  const wsServer = new WebSocketServer({ server: httpServer, path: '/subscriptions' });
  const serverCleanup = useServer({ schema }, wsServer);

  const server = new ApolloServer({
    schema,
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      { async serverWillStart() { return { async drainServer() { await serverCleanup.dispose(); } }; } },
    ],
    introspection: true,
  });

  await server.start();

  app.use(cors({
    origin: (origin, callback) => callback(null, origin || true),
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use('/graphql', expressMiddleware(server, {
    context: async ({ req }) => ({ token: req.headers.authorization }),
  }));

  app.get('/health', (_, res) => res.json({ status: 'ok', service: 'graphql-api' }));

  await new Promise(resolve => httpServer.listen({ port: PORT }, resolve));
  console.log(`🚀 TrialOS GraphQL API ready at http://localhost:${PORT}/graphql`);
}

if (require.main === module) {
  startServer().catch(console.error);
}

module.exports = {
  typeDefs,
  resolvers,
  SERVICES,
  startServer,
};
