-- Migration 004: Context Graph System
-- Adds: document type registry, knowledge graph nodes/edges, context index,
--        decision traces, feedback, and pending document classifications.
-- Idempotent.

-- ─── Document Type Registry ───────────────────────────────────────────────────
-- Platform-wide known document types + org-defined custom types.
-- detection_patterns: array of {pattern_type: "keyword"|"regex"|"structure", value, weight}
-- schema_hints: {expected_sections: [], key_fields: [], typical_length: "short|medium|long"}

CREATE TABLE IF NOT EXISTS document_type_registry (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    type_code           TEXT        NOT NULL UNIQUE,
    type_name           TEXT        NOT NULL,
    description         TEXT,
    detection_patterns  JSONB       NOT NULL DEFAULT '[]',
    schema_hints        JSONB       NOT NULL DEFAULT '{}',
    is_system           BOOLEAN     NOT NULL DEFAULT FALSE,
    org_id              UUID        REFERENCES organizations(id),   -- NULL = platform-wide
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed system document types
INSERT INTO document_type_registry (type_code, type_name, description, is_system, detection_patterns, schema_hints)
VALUES
  ('protocol',      'Clinical Study Protocol',        'Master protocol document defining study objectives, design, and procedures',    TRUE,
   '[{"type":"keyword","value":"investigational product","weight":0.8},{"type":"keyword","value":"protocol number","weight":0.9},{"type":"keyword","value":"inclusion criteria","weight":0.85},{"type":"keyword","value":"exclusion criteria","weight":0.85}]',
   '{"expected_sections":["Background","Objectives","Design","Population","Endpoints","Statistical Methods"],"typical_length":"long"}'),
  ('sap',           'Statistical Analysis Plan',      'Pre-specified statistical analysis plan',                                       TRUE,
   '[{"type":"keyword","value":"statistical analysis plan","weight":0.95},{"type":"keyword","value":"analysis sets","weight":0.8},{"type":"keyword","value":"primary endpoint","weight":0.75},{"type":"keyword","value":"multiplicity","weight":0.7}]',
   '{"expected_sections":["Analysis Sets","Primary Analysis","Secondary Analysis","Sensitivity Analysis","Missing Data"],"typical_length":"long"}'),
  ('crf',           'Case Report Form',               'Electronic or paper CRF with field definitions',                               TRUE,
   '[{"type":"keyword","value":"case report form","weight":0.9},{"type":"keyword","value":"visit schedule","weight":0.7},{"type":"keyword","value":"data entry","weight":0.6}]',
   '{"expected_sections":["Visit Schedule","Form Definitions","Completion Instructions"],"typical_length":"medium"}'),
  ('csr',           'Clinical Study Report',          'Final comprehensive study report (ICH E3)',                                     TRUE,
   '[{"type":"keyword","value":"clinical study report","weight":0.9},{"type":"keyword","value":"study results","weight":0.7},{"type":"keyword","value":"serious adverse events","weight":0.75}]',
   '{"expected_sections":["Synopsis","Introduction","Methods","Results","Discussion","Conclusions"],"typical_length":"long"}'),
  ('sdtm_ig',       'SDTM Implementation Guide',      'CDISC SDTM implementation guide',                                              TRUE,
   '[{"type":"keyword","value":"SDTM","weight":0.9},{"type":"keyword","value":"CDISC","weight":0.8},{"type":"keyword","value":"domain","weight":0.6},{"type":"keyword","value":"controlled terminology","weight":0.75}]',
   '{"expected_sections":["General Assumptions","Domain Models","Datasets"],"typical_length":"long"}'),
  ('adam_ig',       'ADaM Implementation Guide',      'CDISC ADaM implementation guide',                                              TRUE,
   '[{"type":"keyword","value":"ADaM","weight":0.9},{"type":"keyword","value":"analysis dataset","weight":0.8},{"type":"keyword","value":"ADSL","weight":0.75}]',
   '{"expected_sections":["ADaM Datasets","Derivation Rules","Variable Conventions"],"typical_length":"long"}'),
  ('lab_manual',    'Laboratory Manual',              'Central/site laboratory procedures manual',                                     TRUE,
   '[{"type":"keyword","value":"laboratory","weight":0.7},{"type":"keyword","value":"specimen","weight":0.8},{"type":"keyword","value":"normal range","weight":0.75},{"type":"keyword","value":"sample handling","weight":0.8}]',
   '{"expected_sections":["Contact Information","Specimen Collection","Processing","Shipping","Reference Ranges"],"typical_length":"medium"}'),
  ('dmp',           'Data Management Plan',           'Study data management plan',                                                    TRUE,
   '[{"type":"keyword","value":"data management plan","weight":0.95},{"type":"keyword","value":"data cleaning","weight":0.8},{"type":"keyword","value":"database lock","weight":0.8}]',
   '{"expected_sections":["Data Flow","Edit Checks","Query Management","Database Lock"],"typical_length":"medium"}'),
  ('icf',           'Informed Consent Form',          'Patient informed consent form',                                                 TRUE,
   '[{"type":"keyword","value":"informed consent","weight":0.9},{"type":"keyword","value":"voluntary participation","weight":0.85},{"type":"keyword","value":"risks and benefits","weight":0.8}]',
   '{"expected_sections":["Purpose","Procedures","Risks","Benefits","Confidentiality","Withdrawal"],"typical_length":"medium"}')
ON CONFLICT (type_code) DO NOTHING;

-- ─── Context Nodes ────────────────────────────────────────────────────────────
-- Vertices in the knowledge graph.
-- external_id: the UUID of the actual record (document, chunk, agent_run, etc.)

CREATE TABLE IF NOT EXISTS context_nodes (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    node_type           TEXT        NOT NULL CHECK (node_type IN (
                            'document',     -- a full document
                            'chunk',        -- a chunk of text from a document
                            'entity',       -- an extracted named entity / concept instance
                            'concept',      -- a canonical clinical/regulatory concept
                            'agent_run',    -- an agent execution
                            'decision',     -- a specific decision/output from an agent run
                            'feedback',     -- user/expert feedback on a decision
                            'sdtm_domain',  -- SDTM domain (AE, LB, VS, etc.)
                            'sdtm_variable',-- SDTM variable within a domain
                            'codelist',     -- CDISC codelist
                            'codelist_term' -- individual codelist term
                        )),
    external_id         TEXT,               -- FK-style reference to the underlying table row
    org_id              UUID        NOT NULL REFERENCES organizations(id),
    study_id            UUID        REFERENCES studies(id),
    label               TEXT        NOT NULL,
    metadata            JSONB       NOT NULL DEFAULT '{}',
    embedding           VECTOR(768),
    importance_weight   FLOAT       NOT NULL DEFAULT 1.0,  -- adjusted by feedback
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ctx_nodes_org_study
    ON context_nodes (org_id, study_id, node_type);

CREATE INDEX IF NOT EXISTS idx_ctx_nodes_external
    ON context_nodes (external_id)
    WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ctx_nodes_embedding
    ON context_nodes USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 50)
    WHERE embedding IS NOT NULL;

-- ─── Context Edges ────────────────────────────────────────────────────────────
-- Directed relationships between context nodes.

CREATE TABLE IF NOT EXISTS context_edges (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    source_node_id  UUID        NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
    target_node_id  UUID        NOT NULL REFERENCES context_nodes(id) ON DELETE CASCADE,
    edge_type       TEXT        NOT NULL CHECK (edge_type IN (
                        'contains',         -- document → chunk
                        'extracted_from',   -- entity → chunk
                        'references',       -- chunk → entity
                        'cites',            -- decision → chunk/entity
                        'produced_by',      -- decision/artifact → agent_run
                        'influenced_by',    -- decision → prior decision/feedback
                        'derived_from',     -- data/concept → source (lineage)
                        'co_occurs_with',   -- entity ↔ entity (within same chunk)
                        'is_type',          -- entity instance → canonical concept
                        'has_feedback',     -- decision → feedback
                        'version_of'        -- newer document → older document
                    )),
    weight          FLOAT       NOT NULL DEFAULT 1.0,
    metadata        JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ctx_edges_source ON context_edges (source_node_id);
CREATE INDEX IF NOT EXISTS idx_ctx_edges_target ON context_edges (target_node_id);
CREATE INDEX IF NOT EXISTS idx_ctx_edges_type   ON context_edges (edge_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ctx_edges_unique
    ON context_edges (source_node_id, target_node_id, edge_type);

-- ─── Context Index ────────────────────────────────────────────────────────────
-- Queryable summaries per entity/concept, with aggregated embeddings.
-- This is what agents query first — the graph is traversed for citations.

CREATE TABLE IF NOT EXISTS context_index (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID        NOT NULL REFERENCES organizations(id),
    study_id        UUID        REFERENCES studies(id),
    entity_key      TEXT        NOT NULL,   -- normalised key e.g. "adverse_event_grading_criteria"
    entity_type     TEXT        NOT NULL,   -- clinical_concept|endpoint|procedure|population|regulatory|other
    summary         TEXT        NOT NULL,   -- LLM-generated summary with citations
    source_node_ids UUID[]      NOT NULL DEFAULT '{}',
    embedding       VECTOR(768),
    confidence      FLOAT       NOT NULL DEFAULT 1.0,
    quality_score   FLOAT       NOT NULL DEFAULT 1.0,  -- updated by feedback
    access_count    INTEGER     NOT NULL DEFAULT 0,
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, study_id, entity_key)
);

CREATE INDEX IF NOT EXISTS idx_ctx_index_org_study ON context_index (org_id, study_id);
CREATE INDEX IF NOT EXISTS idx_ctx_index_embedding
    ON context_index USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 50)
    WHERE embedding IS NOT NULL;

-- ─── Decision Traces ─────────────────────────────────────────────────────────
-- Captures agent reasoning for explainability and reproducibility.

CREATE TABLE IF NOT EXISTS decision_traces (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id    UUID        REFERENCES agent_runs(id),
    org_id          UUID        NOT NULL REFERENCES organizations(id),
    study_id        UUID        REFERENCES studies(id),
    trace_type      TEXT        NOT NULL DEFAULT 'tool_call'
                        CHECK (trace_type IN ('tool_call','reasoning','synthesis','output')),
    input_context   JSONB       NOT NULL DEFAULT '{}',  -- query + context passed in
    reasoning_steps JSONB       NOT NULL DEFAULT '[]',  -- [{step, thought, tool_used, result}]
    sources_cited   JSONB       NOT NULL DEFAULT '[]',  -- [{node_id, chunk_id, score, text_excerpt, doc_name}]
    output          JSONB       NOT NULL DEFAULT '{}',  -- the actual output produced
    confidence      FLOAT       NOT NULL DEFAULT 1.0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_traces_run_id ON decision_traces (agent_run_id);
CREATE INDEX IF NOT EXISTS idx_traces_org    ON decision_traces (org_id, study_id, created_at DESC);

-- ─── Context Feedback ─────────────────────────────────────────────────────────
-- User/expert feedback on agent decisions — drives context quality improvement.

CREATE TABLE IF NOT EXISTS context_feedback (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id        UUID        REFERENCES agent_runs(id),
    decision_trace_id   UUID        REFERENCES decision_traces(id),
    org_id              UUID        NOT NULL REFERENCES organizations(id),
    feedback_type       TEXT        NOT NULL
                            CHECK (feedback_type IN ('rating','correction','endorsement','rejection')),
    feedback_value      JSONB       NOT NULL DEFAULT '{}',  -- {rating:4} or {corrected_text:"...", reason:"..."}
    submitted_by        TEXT        NOT NULL,
    processed           BOOLEAN     NOT NULL DEFAULT FALSE, -- TRUE after weights updated
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_trace ON context_feedback (decision_trace_id);
CREATE INDEX IF NOT EXISTS idx_feedback_run   ON context_feedback (agent_run_id);
CREATE INDEX IF NOT EXISTS idx_feedback_unprocessed ON context_feedback (processed, created_at)
    WHERE processed = FALSE;

-- ─── Pending Document Classifications ────────────────────────────────────────
-- Documents uploaded with type='auto' that the system couldn't confidently classify.

CREATE TABLE IF NOT EXISTS pending_classifications (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id         UUID        NOT NULL REFERENCES documents(id) UNIQUE,
    org_id              UUID        NOT NULL REFERENCES organizations(id),
    auto_detected_hints JSONB       NOT NULL DEFAULT '{}',  -- {keywords, structure_type, confidence}
    llm_analysis        TEXT,                               -- LLM description of document
    suggested_type_codes TEXT[]     NOT NULL DEFAULT '{}',  -- ordered by confidence
    confidence_scores   JSONB       NOT NULL DEFAULT '{}',  -- {type_code: score, ...}
    metadata_extracted  JSONB       NOT NULL DEFAULT '{}',  -- key-value metadata found
    status              TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','mapped','dismissed')),
    resolved_type       TEXT,                               -- user-chosen type_code
    resolved_by         TEXT,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_class_org    ON pending_classifications (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pending_class_status ON pending_classifications (status) WHERE status = 'pending';

-- ─── Kafka Event Log (lightweight) ───────────────────────────────────────────
-- Records graph-relevant events consumed from Kafka for replay/audit.

CREATE TABLE IF NOT EXISTS context_events (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type  TEXT        NOT NULL,   -- document.processed|agent_run.completed|feedback.submitted
    source      TEXT        NOT NULL,   -- which service emitted
    payload     JSONB       NOT NULL DEFAULT '{}',
    processed   BOOLEAN     NOT NULL DEFAULT FALSE,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ctx_events_unprocessed ON context_events (processed, created_at)
    WHERE processed = FALSE;

-- ─── Schema version ──────────────────────────────────────────────────────────
INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', '004')
    ON CONFLICT (key) DO UPDATE SET value = '004', set_at = NOW();
