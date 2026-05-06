-- Migration 033 — Agent Flow Definitions & Super Agent Registration
-- Registers the L4 Super Agent and adds visual flow_definition JSONB
-- to all key agents so /agents/flow-view/{slug} renders a diagram.

-- ─── Register L4 Super Agent ────────────────────────────────────────────────
INSERT INTO agent_definitions
    (id, name, slug, version, category, description, agent_type, agent_purpose,
     is_published, is_verified, publisher_type, accuracy_rate, reputation_score, avg_latency_ms)
VALUES
    ('00000000-0000-0000-0000-000000000030',
     'L4 Super Agent Orchestrator',
     'l4-super-agent',
     '1.0.0',
     'orchestration',
     'Cognitive L4 orchestrator with 8 engines: Intent Understanding, Task Decomposition, '
     'Agent Routing (reputation-weighted), Risk-Based Planning, Cost Optimisation, '
     'Confidence Orchestration, Recovery/Retry (graduated cascade), and Pre-Execution Gate. '
     'Routes tasks to L5 specialist agents and manages HITL escalation.',
     'trialo_native',
     'orchestration',
     true,
     true,
     'trialo-native',
     0.92,
     0.90,
     3000)
ON CONFLICT (id) DO NOTHING;

-- ─── Register SDTM Conformance Checker ──────────────────────────────────────
INSERT INTO agent_definitions
    (id, name, slug, version, category, description, agent_type, agent_purpose,
     is_published, is_verified, publisher_type, accuracy_rate, reputation_score, avg_latency_ms)
VALUES
    ('00000000-0000-0000-0000-000000000031',
     'SDTM Conformance Checker',
     'sdtm-conformance-checker',
     '1.0.0',
     'data',
     'Validates SDTM datasets against CDISC SDTM IG rules. Checks domain structure, '
     'required variables, controlled terminology, and cross-domain consistency.',
     'trialo_native',
     'data_validation',
     true,
     true,
     'trialo-native',
     0.90,
     0.85,
     2500)
ON CONFLICT (id) DO NOTHING;

-- ─── Register Missing Data Sweeper ──────────────────────────────────────────
INSERT INTO agent_definitions
    (id, name, slug, version, category, description, agent_type, agent_purpose,
     is_published, is_verified, publisher_type, accuracy_rate, reputation_score, avg_latency_ms)
VALUES
    ('00000000-0000-0000-0000-000000000032',
     'Missing Data Sweeper',
     'missing-data-sweeper',
     '1.0.0',
     'data',
     'Scans clinical datasets for missing values, out-of-range entries, and data quality issues. '
     'Generates targeted data queries (DCFs) and tracks resolution.',
     'trialo_native',
     'data_quality',
     true,
     true,
     'trialo-native',
     0.88,
     0.82,
     1800)
ON CONFLICT (id) DO NOTHING;

-- ─── Register Query Rate Monitor ────────────────────────────────────────────
INSERT INTO agent_definitions
    (id, name, slug, version, category, description, agent_type, agent_purpose,
     is_published, is_verified, publisher_type, accuracy_rate, reputation_score, avg_latency_ms)
VALUES
    ('00000000-0000-0000-0000-000000000033',
     'Query Rate Monitor',
     'query-rate-monitor',
     '1.0.0',
     'operations',
     'Monitors open data query (DCF) rates by site and domain. Alerts on query '
     'rate spikes and predicts query backlog based on historical patterns.',
     'trialo_native',
     'monitoring',
     true,
     true,
     'trialo-native',
     0.87,
     0.83,
     1200)
ON CONFLICT (id) DO NOTHING;

-- ─── Flow Definition: L4 Super Agent ────────────────────────────────────────
UPDATE agent_definitions SET flow_definition = '{
  "nodes": [
    {"id":"input",      "type":"data_source","label":"User Intent / Request",        "config":{"sourceType":"documents","description":"Natural language task from user or system trigger"}},
    {"id":"e1_intent",  "type":"llm",        "label":"L4.E1 Intent Understanding",   "config":{"description":"4-dimension intent analysis","dimensions":"task_type · scope · tone · complexity","provider":"ollama","model":"llama3.1:8b"}},
    {"id":"e2_decompose","type":"planner",   "label":"L4.E2 Task Decomposition",     "config":{"objective":"Split intent into parallel-safe ordered steps","maxTasks":10,"contextHint":"Identify data dependencies between steps"}},
    {"id":"e8_gate",    "type":"reflect",    "label":"L4.E8 Pre-Execution Gate",     "config":{"rubric":"All agent slugs known · steps ≤10 · no circular deps · risk acceptable","scoreThreshold":0.70}},
    {"id":"e3_route",   "type":"agent",      "label":"L4.E3 Agent Routing",          "config":{"agentName":"Reputation-Weighted Router","agentMode":"select","description":"Selects best-fit agent per step using reputation scores + capability match"}},
    {"id":"e4_risk",    "type":"condition",  "label":"L4.E4 Risk-Based Planning",    "config":{"conditionField":"risk_tier","conditionOp":"in","conditionValue":"low,medium,high","description":"Tier 1=auto · Tier 2=flagged · Tier 3=HITL required (conf<0.70)"}},
    {"id":"e5_cost",    "type":"llm",        "label":"L4.E5 Cost Optimisation",      "config":{"description":"Maps complexity to model: simple→local LLM · medium→gpt-3.5 · complex→gpt-4","provider":"ollama"}},
    {"id":"hitl_gate",  "type":"hitl",       "label":"HITL Approval Gate",           "config":{"hitlDescription":"Human review required for Tier 3 risk or confidence below threshold","hitlAssignedRole":"analyst"}},
    {"id":"e6_conf",    "type":"condition",  "label":"L4.E6 Confidence Orchestration","config":{"conditionField":"confidence","conditionOp":">=","conditionValue":"0.75","description":"≥0.75 proceed · 0.50–0.74 escalate · <0.50 defer"}},
    {"id":"sub_exec",   "type":"agent",      "label":"Sub-Agent Execution",          "config":{"agentName":"L5 Specialist","agentMode":"execute","description":"Runs the selected L5 specialist agent with enriched context"}},
    {"id":"e7_retry",   "type":"condition",  "label":"L4.E7 Recovery / Retry",       "config":{"conditionField":"attempt","conditionOp":"<=","conditionValue":"3","description":"Attempt 1: reprompt · Attempt 2: alternate agent · Attempt 3: HITL"}},
    {"id":"mem_write",  "type":"memory",     "label":"Memory Write-Back",            "config":{"memoryOperation":"write","memoryKey":"orchestration_result","description":"Stores plan outcome, agent performance deltas, learning extracts"}},
    {"id":"output",     "type":"output",     "label":"Orchestrated Result",          "config":{"outputFormat":"json","outputTitle":"Plan + Step Results + Confidence Trace"}}
  ],
  "edges": [
    {"source":"input",      "target":"e1_intent"},
    {"source":"e1_intent",  "target":"e2_decompose"},
    {"source":"e2_decompose","target":"e8_gate"},
    {"source":"e8_gate",    "target":"e3_route",  "label":"gate passed"},
    {"source":"e8_gate",    "target":"e2_decompose","label":"re-plan"},
    {"source":"e3_route",   "target":"e4_risk"},
    {"source":"e4_risk",    "target":"e5_cost",   "label":"Tier 1-2"},
    {"source":"e4_risk",    "target":"hitl_gate", "label":"Tier 3"},
    {"source":"hitl_gate",  "target":"e5_cost",   "label":"approved"},
    {"source":"e5_cost",    "target":"e6_conf"},
    {"source":"e6_conf",    "target":"sub_exec",  "label":"conf ≥ 0.75"},
    {"source":"e6_conf",    "target":"e7_retry",  "label":"conf < 0.75"},
    {"source":"e7_retry",   "target":"sub_exec",  "label":"retry ≤ 3"},
    {"source":"e7_retry",   "target":"hitl_gate", "label":"max retries"},
    {"source":"sub_exec",   "target":"e6_conf",   "label":"re-evaluate"},
    {"source":"sub_exec",   "target":"mem_write"},
    {"source":"mem_write",  "target":"output"}
  ]
}'::jsonb
WHERE slug = 'l4-super-agent';

-- ─── Flow Definition: Protocol-USDM Cognitive Agent ─────────────────────────
UPDATE agent_definitions SET flow_definition = '{
  "nodes": [
    {"id":"input",      "type":"data_source","label":"Protocol Document",            "config":{"sourceType":"documents","description":"PDF, DOCX, or TXT protocol file","formats":"PDF · DOCX · TXT"}},
    {"id":"retrieval",  "type":"context_graph","label":"Retrieval Augmentation",    "config":{"graphName":"Protocol Context","queryTemplate":"Extract USDM-relevant sections","topK":10,"description":"Pulls prior learnings, gold patterns, and USDM IG from context graph"}},
    {"id":"s1_parse",   "type":"llm",        "label":"S1 Section Parsing",          "config":{"description":"Maps ICH M11 14-section structure to USDM 10 mandatory sections","provider":"ollama","model":"llama3.1:8b","confidence_weight":"0.35"}},
    {"id":"s2_eligib",  "type":"llm",        "label":"S2 Eligibility Extraction",   "config":{"description":"Extracts inclusion/exclusion criteria with SNOMED coding","provider":"ollama","confidence_weight":"0.30"}},
    {"id":"s3_sched",   "type":"llm",        "label":"S3 Schedule Recognition",     "config":{"description":"Parses visit schedule, assessments, and timing windows","provider":"ollama","confidence_weight":"0.20"}},
    {"id":"s4_feasib",  "type":"llm",        "label":"S4 Feasibility Comparison",   "config":{"description":"Cross-references study design against historical protocols","provider":"ollama","confidence_weight":"0.15"}},
    {"id":"assemble",   "type":"code",       "label":"USDM v4.0 Assembly",          "config":{"language":"python","description":"Merges S1-S4 outputs into USDM v4.0 JSON with 10 mandatory sections"}},
    {"id":"e11_acc",    "type":"reflect",    "label":"E11 Accuracy",                "config":{"rubric":"USDM fields map correctly to source protocol text","scoreThreshold":0.85}},
    {"id":"e12_comp",   "type":"reflect",    "label":"E12 Completeness",            "config":{"rubric":"All 10 mandatory USDM sections populated","scoreThreshold":0.90}},
    {"id":"e13_std",    "type":"reflect",    "label":"E13 Standards Adherence",     "config":{"rubric":"Values conform to USDM v4.0 schema and CDISC controlled terminology","scoreThreshold":0.80}},
    {"id":"e14_hall",   "type":"reflect",    "label":"E14 Hallucination Detection", "config":{"rubric":"No fabricated protocol details; all claims traceable to source","scoreThreshold":0.95}},
    {"id":"e15_read",   "type":"reflect",    "label":"E15 Readability",             "config":{"rubric":"Output is clear and consistent with clinical writing standards","scoreThreshold":0.70}},
    {"id":"e16_cost",   "type":"reflect",    "label":"E16 Cost",                    "config":{"rubric":"Total token cost within $1.00 per conversion","scoreThreshold":1.00}},
    {"id":"e17_cons",   "type":"reflect",    "label":"E17 Consistency",             "config":{"rubric":"Cross-section terminology is consistent (same terms for same concepts)","scoreThreshold":0.80}},
    {"id":"eval_gate",  "type":"condition",  "label":"Evaluator Gate",              "config":{"conditionField":"all_thresholds_met","conditionOp":"==","conditionValue":"true","description":"ALL 7 evaluators must pass their threshold"}},
    {"id":"retry",      "type":"condition",  "label":"E18 Retry Tree (5 Levels)",   "config":{"conditionField":"retry_level","conditionOp":"<=","conditionValue":"5","description":"L1 reprompt · L2 broaden retrieval · L3 escalate model → gpt-4 · L4 alternate agent · L5 HITL"}},
    {"id":"hitl",       "type":"hitl",       "label":"L5 HITL Escalation",         "config":{"hitlDescription":"Clinical expert reviews failed USDM sections","hitlAssignedRole":"analyst","hitlFormId":"usdm_review"}},
    {"id":"mem_ep",     "type":"memory",     "label":"E8 Episodic Memory",          "config":{"memoryOperation":"write","memoryKey":"usdm_run_episode","description":"Stores run context, inputs, decisions, and outcome"}},
    {"id":"mem_sem",    "type":"memory",     "label":"E9 Semantic Facts",           "config":{"memoryOperation":"write","memoryKey":"usdm_semantic","description":"Extracts reusable semantic facts (disease area, endpoints, population)"}},
    {"id":"mem_pat",    "type":"memory",     "label":"E10 Gold / Anti-Patterns",    "config":{"memoryOperation":"write","memoryKey":"usdm_patterns","description":"Writes gold_pattern (passed run) or anti_pattern (HITL correction) to agent_learnings"}},
    {"id":"output",     "type":"output",     "label":"USDM v4.0 JSON",              "config":{"outputFormat":"json","outputTitle":"USDM v4.0 Structured Protocol"}}
  ],
  "edges": [
    {"source":"input",    "target":"retrieval"},
    {"source":"retrieval","target":"s1_parse"},
    {"source":"s1_parse", "target":"s2_eligib"},
    {"source":"s2_eligib","target":"s3_sched"},
    {"source":"s3_sched", "target":"s4_feasib"},
    {"source":"s4_feasib","target":"assemble"},
    {"source":"assemble", "target":"e11_acc"},
    {"source":"assemble", "target":"e12_comp"},
    {"source":"assemble", "target":"e13_std"},
    {"source":"assemble", "target":"e14_hall"},
    {"source":"assemble", "target":"e15_read"},
    {"source":"assemble", "target":"e16_cost"},
    {"source":"assemble", "target":"e17_cons"},
    {"source":"e11_acc",  "target":"eval_gate"},
    {"source":"e12_comp", "target":"eval_gate"},
    {"source":"e13_std",  "target":"eval_gate"},
    {"source":"e14_hall", "target":"eval_gate"},
    {"source":"e15_read", "target":"eval_gate"},
    {"source":"e16_cost", "target":"eval_gate"},
    {"source":"e17_cons", "target":"eval_gate"},
    {"source":"eval_gate","target":"output",   "label":"all pass"},
    {"source":"eval_gate","target":"retry",    "label":"any fail"},
    {"source":"retry",    "target":"s1_parse", "label":"L1-L3 retry"},
    {"source":"retry",    "target":"hitl",     "label":"L5 escalate"},
    {"source":"hitl",     "target":"assemble", "label":"corrections applied"},
    {"source":"output",   "target":"mem_ep"},
    {"source":"output",   "target":"mem_sem"},
    {"source":"output",   "target":"mem_pat"}
  ]
}'::jsonb
WHERE slug = 'protocol-usdm-cognitive';

-- ─── Flow Definition: SDTM Conformance Checker ──────────────────────────────
UPDATE agent_definitions SET flow_definition = '{
  "nodes": [
    {"id":"input",    "type":"data_source","label":"SDTM Dataset (.xpt)",     "config":{"sourceType":"sdtm","description":"SAS XPT files for one or more SDTM domains"}},
    {"id":"ig_fetch", "type":"context_graph","label":"SDTM IG Rules",        "config":{"graphName":"SDTM IG","description":"Fetches conformance rules for the domain from context graph"}},
    {"id":"struct",   "type":"code",       "label":"Domain Structure Check",  "config":{"language":"python","description":"Validates required variables, permitted variables, domain label"}},
    {"id":"ct_check", "type":"code",       "label":"Controlled Terminology",  "config":{"language":"python","description":"Checks variable values against CDISC CT codelists"}},
    {"id":"cross",    "type":"llm",        "label":"Cross-Domain Consistency", "config":{"description":"Validates subject IDs and timing across DM, AE, LB, VS, EX domains"}},
    {"id":"findings", "type":"reflect",    "label":"Conformance Scoring",     "config":{"rubric":"Errors, warnings, and informational findings aggregated per domain","scoreThreshold":0.80}},
    {"id":"gate",     "type":"condition",  "label":"Severity Gate",           "config":{"conditionField":"error_count","conditionOp":"==","conditionValue":"0","description":"Errors block submission · Warnings require review · Info informational only"}},
    {"id":"hitl",     "type":"hitl",       "label":"Error Review",            "config":{"hitlDescription":"Critical errors require data management review","hitlAssignedRole":"analyst"}},
    {"id":"output",   "type":"output",     "label":"Conformance Report",      "config":{"outputFormat":"json","outputTitle":"SDTM Conformance Report"}},
    {"id":"mem",      "type":"memory",     "label":"Learning Write-Back",     "config":{"memoryOperation":"write","memoryKey":"sdtm_conformance_run"}}
  ],
  "edges": [
    {"source":"input",   "target":"ig_fetch"},
    {"source":"ig_fetch","target":"struct"},
    {"source":"struct",  "target":"ct_check"},
    {"source":"ct_check","target":"cross"},
    {"source":"cross",   "target":"findings"},
    {"source":"findings","target":"gate"},
    {"source":"gate",    "target":"output",  "label":"no errors"},
    {"source":"gate",    "target":"hitl",    "label":"errors found"},
    {"source":"hitl",    "target":"output",  "label":"reviewed"},
    {"source":"output",  "target":"mem"}
  ]
}'::jsonb
WHERE slug = 'sdtm-conformance-checker';

-- ─── Flow Definition: ICH M11 Validator ─────────────────────────────────────
UPDATE agent_definitions SET flow_definition = '{
  "nodes": [
    {"id":"input",   "type":"data_source","label":"Protocol Document",          "config":{"sourceType":"documents","description":"Clinical protocol in any format"}},
    {"id":"extract", "type":"llm",        "label":"ICH M11 Section Extraction",  "config":{"description":"Extracts 14 ICH M11 CeSHarP sections from protocol","provider":"ollama","model":"llama3.1:8b"}},
    {"id":"validate","type":"reflect",    "label":"ICH M11 Conformance Check",   "config":{"rubric":"All 14 sections present and compliant with ICH M11 template","scoreThreshold":0.80}},
    {"id":"gap",     "type":"code",       "label":"Gap Detection",               "config":{"language":"python","description":"Identifies missing or incomplete sections, generates remediation list"}},
    {"id":"gate",    "type":"condition",  "label":"Compliance Gate",             "config":{"conditionField":"compliance_score","conditionOp":">=","conditionValue":"0.80"}},
    {"id":"hitl",    "type":"hitl",       "label":"Regulatory Review",           "config":{"hitlDescription":"Medical writer review for non-compliant sections","hitlAssignedRole":"analyst"}},
    {"id":"output",  "type":"output",     "label":"ICH M11 Validation Report",   "config":{"outputFormat":"json","outputTitle":"ICH M11 Compliance Assessment"}}
  ],
  "edges": [
    {"source":"input",   "target":"extract"},
    {"source":"extract", "target":"validate"},
    {"source":"validate","target":"gap"},
    {"source":"gap",     "target":"gate"},
    {"source":"gate",    "target":"output", "label":"compliant"},
    {"source":"gate",    "target":"hitl",   "label":"non-compliant"},
    {"source":"hitl",    "target":"output", "label":"reviewed"}
  ]
}'::jsonb
WHERE slug = 'ich-m11-validator';

-- ─── Flow Definition: Protocol ICH M11 Converter ────────────────────────────
UPDATE agent_definitions SET flow_definition = '{
  "nodes": [
    {"id":"input",    "type":"data_source","label":"Protocol Document",             "config":{"sourceType":"documents","description":"Source protocol PDF or DOCX"}},
    {"id":"retrieval","type":"context_graph","label":"ICH M11 Template Retrieval", "config":{"graphName":"ICH M11 IG","description":"Fetches ICH M11 template structure and field requirements"}},
    {"id":"map",      "type":"llm",        "label":"Section Mapping",               "config":{"description":"Maps existing protocol content to ICH M11 14-section structure","provider":"ollama"}},
    {"id":"rewrite",  "type":"llm",        "label":"ICH M11 Rewrite",              "config":{"description":"Rewrites each section in ICH M11 CeSHarP format","provider":"ollama"}},
    {"id":"validate", "type":"reflect",    "label":"Conformance Validation",        "config":{"rubric":"Output matches ICH M11 template requirements","scoreThreshold":0.85}},
    {"id":"gate",     "type":"condition",  "label":"Quality Gate",                  "config":{"conditionField":"validation_score","conditionOp":">=","conditionValue":"0.85"}},
    {"id":"hitl",     "type":"hitl",       "label":"Writer Review",                 "config":{"hitlDescription":"Medical writer reviews converted M11 protocol","hitlAssignedRole":"analyst"}},
    {"id":"output",   "type":"output",     "label":"ICH M11 Protocol",              "config":{"outputFormat":"json","outputTitle":"ICH M11 CeSHarP Formatted Protocol"}}
  ],
  "edges": [
    {"source":"input",    "target":"retrieval"},
    {"source":"retrieval","target":"map"},
    {"source":"map",      "target":"rewrite"},
    {"source":"rewrite",  "target":"validate"},
    {"source":"validate", "target":"gate"},
    {"source":"gate",     "target":"output", "label":"passes"},
    {"source":"gate",     "target":"hitl",   "label":"fails"},
    {"source":"hitl",     "target":"output", "label":"approved"}
  ]
}'::jsonb
WHERE slug = 'protocol-ich-m11-converter';

-- ─── Flow Definition: Standards Mapping ─────────────────────────────────────
UPDATE agent_definitions SET flow_definition = '{
  "nodes": [
    {"id":"input",  "type":"data_source","label":"EDC Source Data",               "config":{"sourceType":"raw_edc","description":"CSV or XLSX from EDC system"}},
    {"id":"ig",     "type":"context_graph","label":"SDTM IG Lookup",             "config":{"graphName":"SDTM IG","topK":20,"description":"Retrieves SDTM variable definitions and mapping rules"}},
    {"id":"det",    "type":"code",       "label":"Deterministic Rules",           "config":{"language":"python","description":"Applies exact-match and regex mapping rules (fast path, no LLM)"}},
    {"id":"gate",   "type":"condition",  "label":"Coverage Gate",                 "config":{"conditionField":"unmapped_count","conditionOp":">","conditionValue":"0","description":"All columns mapped? → output. Unmapped? → LLM fallback"}},
    {"id":"llm",    "type":"llm",        "label":"LLM Fallback Mapping",          "config":{"description":"Uses LLM to infer SDTM mappings for unmatched columns","provider":"ollama","model":"llama3.1:8b"}},
    {"id":"valid",  "type":"reflect",    "label":"Mapping Validation",            "config":{"rubric":"All mappings have confidence ≥0.70 and valid SDTM variable targets","scoreThreshold":0.70}},
    {"id":"hitl",   "type":"hitl",       "label":"Low-Confidence Review",         "config":{"hitlDescription":"Data manager reviews mappings below 70% confidence","hitlAssignedRole":"analyst"}},
    {"id":"mem",    "type":"memory",     "label":"Mapping Memory",                "config":{"memoryOperation":"write","memoryKey":"sdtm_mapping","description":"Stores approved mappings as gold patterns for future runs"}},
    {"id":"output", "type":"output",     "label":"SDTM Mapping Specification",    "config":{"outputFormat":"json","outputTitle":"EDC → SDTM Mapping Spec"}}
  ],
  "edges": [
    {"source":"input", "target":"ig"},
    {"source":"ig",    "target":"det"},
    {"source":"det",   "target":"gate"},
    {"source":"gate",  "target":"valid",  "label":"all mapped"},
    {"source":"gate",  "target":"llm",    "label":"unmapped cols"},
    {"source":"llm",   "target":"valid"},
    {"source":"valid", "target":"output", "label":"conf ≥ 0.70"},
    {"source":"valid", "target":"hitl",   "label":"conf < 0.70"},
    {"source":"hitl",  "target":"mem",    "label":"corrections"},
    {"source":"mem",   "target":"output"}
  ]
}'::jsonb
WHERE slug = 'standards-mapping';

-- ─── Flow Definition: Evaluator ─────────────────────────────────────────────
UPDATE agent_definitions SET flow_definition = '{
  "nodes": [
    {"id":"input",  "type":"data_source","label":"Agent Output",     "config":{"sourceType":"documents","description":"Output from any agent run to be evaluated"}},
    {"id":"d1",     "type":"reflect",    "label":"Accuracy",         "config":{"rubric":"Output facts match source documents","scoreThreshold":0.80}},
    {"id":"d2",     "type":"reflect",    "label":"Compliance",       "config":{"rubric":"Output complies with applicable regulatory guidelines","scoreThreshold":0.80}},
    {"id":"d3",     "type":"reflect",    "label":"Hallucination",    "config":{"rubric":"No fabricated references or unsupported claims","scoreThreshold":0.90}},
    {"id":"d4",     "type":"reflect",    "label":"Readability",      "config":{"rubric":"Text is clear and appropriate for clinical context","scoreThreshold":0.70}},
    {"id":"d5",     "type":"reflect",    "label":"Consistency",      "config":{"rubric":"Terminology consistent throughout the output","scoreThreshold":0.80}},
    {"id":"d6",     "type":"reflect",    "label":"Completeness",     "config":{"rubric":"All required sections and fields are populated","scoreThreshold":0.85}},
    {"id":"agg",    "type":"code",       "label":"Score Aggregation","config":{"language":"python","description":"Weighted average of 6 dimension scores → composite score"}},
    {"id":"output", "type":"output",     "label":"Evaluation Report","config":{"outputFormat":"json","outputTitle":"6-Dimension Quality Score"}}
  ],
  "edges": [
    {"source":"input","target":"d1"},
    {"source":"input","target":"d2"},
    {"source":"input","target":"d3"},
    {"source":"input","target":"d4"},
    {"source":"input","target":"d5"},
    {"source":"input","target":"d6"},
    {"source":"d1","target":"agg"},
    {"source":"d2","target":"agg"},
    {"source":"d3","target":"agg"},
    {"source":"d4","target":"agg"},
    {"source":"d5","target":"agg"},
    {"source":"d6","target":"agg"},
    {"source":"agg","target":"output"}
  ]
}'::jsonb
WHERE slug = 'evaluator';

-- ─── Flow Definition: HITL Coordinator ──────────────────────────────────────
UPDATE agent_definitions SET flow_definition = '{
  "nodes": [
    {"id":"input",   "type":"data_source","label":"Approval Request",     "config":{"sourceType":"documents","description":"HITL task from any agent requiring human review"}},
    {"id":"classify","type":"llm",        "label":"Domain Classification", "config":{"description":"Classifies review domain: data_management, medical, regulatory, writing","provider":"ollama"}},
    {"id":"route",   "type":"condition",  "label":"Role Router",           "config":{"conditionField":"domain","conditionOp":"in","conditionValue":"data_management,medical,regulatory,writing","description":"Routes to appropriate reviewer role based on domain"}},
    {"id":"sla",     "type":"code",       "label":"SLA Assignment",        "config":{"language":"python","description":"Sets deadline: critical=4h · standard=24h · low=72h"}},
    {"id":"notify",  "type":"skill",      "label":"Reviewer Notification", "config":{"skillName":"send_notification","skillType":"function","description":"Notifies assigned reviewer via email/in-app"}},
    {"id":"wait",    "type":"hitl",       "label":"Awaiting Review",       "config":{"hitlDescription":"Reviewer actions: approve / reject / modify with comments","hitlAssignedRole":"analyst"}},
    {"id":"learn",   "type":"memory",     "label":"Adaptive Learning",     "config":{"memoryOperation":"write","memoryKey":"hitl_decision","description":"Stores reviewer decision as gold_pattern or anti_pattern for agent learning"}},
    {"id":"output",  "type":"output",     "label":"Review Decision",       "config":{"outputFormat":"json","outputTitle":"HITL Outcome + Learning Extract"}}
  ],
  "edges": [
    {"source":"input",   "target":"classify"},
    {"source":"classify","target":"route"},
    {"source":"route",   "target":"sla"},
    {"source":"sla",     "target":"notify"},
    {"source":"notify",  "target":"wait"},
    {"source":"wait",    "target":"learn", "label":"decision made"},
    {"source":"learn",   "target":"output"}
  ]
}'::jsonb
WHERE slug = 'hitl-coordinator';

-- ─── Flow Definition: Adaptive Learning ─────────────────────────────────────
UPDATE agent_definitions SET flow_definition = '{
  "nodes": [
    {"id":"input",  "type":"data_source","label":"HITL Decision",         "config":{"sourceType":"documents","description":"Approved/rejected agent output with reviewer notes"}},
    {"id":"diff",   "type":"code",       "label":"Change Extraction",     "config":{"language":"python","description":"Diffs original agent output vs reviewer corrections"}},
    {"id":"class",  "type":"llm",        "label":"Pattern Classification","config":{"description":"Classifies as gold_pattern (good) or anti_pattern (error) with reasoning","provider":"ollama"}},
    {"id":"enrich", "type":"context_graph","label":"Context Enrichment",  "config":{"graphName":"Agent Learnings","description":"Links pattern to relevant USDM sections, domains, or regulatory refs"}},
    {"id":"write",  "type":"memory",     "label":"Learning Write-Back",   "config":{"memoryOperation":"write","memoryKey":"agent_learning","description":"Persists to agent_learnings table with confidence score"}},
    {"id":"repute", "type":"skill",      "label":"Reputation Update",     "config":{"skillName":"update_reputation","skillType":"function","description":"EMA update: new_score = current×0.85 + run×0.15"}},
    {"id":"output", "type":"output",     "label":"Learning Record",       "config":{"outputFormat":"json","outputTitle":"Gold/Anti-Pattern + Reputation Delta"}}
  ],
  "edges": [
    {"source":"input", "target":"diff"},
    {"source":"diff",  "target":"class"},
    {"source":"class", "target":"enrich"},
    {"source":"enrich","target":"write"},
    {"source":"write", "target":"repute"},
    {"source":"repute","target":"output"}
  ]
}'::jsonb
WHERE slug = 'adaptive-learning';

INSERT INTO schema_migrations (version, applied_at)
VALUES ('033_agent_flows', NOW())
ON CONFLICT (version) DO NOTHING;
