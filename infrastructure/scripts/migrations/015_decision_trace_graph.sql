-- Migration 015: Decision Trace Graph + Retrieval Engine
-- Adds: used_in_decision/corrects edge types, mistake/correction node types,
--        document_index_state, entity_canonical_map, context_pack_log tables,
--        mistake_type/graph_node_id columns on decision_traces.
-- Idempotent.

-- ─── 1. Expand context_edges edge_type CHECK ─────────────────────────────────
-- Also fixes 4 types (described_in, has_variable, uses_codelist, has_term) that
-- are used in build_document_graph but were absent from the original constraint.

ALTER TABLE context_edges
    DROP CONSTRAINT IF EXISTS context_edges_edge_type_check;

ALTER TABLE context_edges
    ADD CONSTRAINT context_edges_edge_type_check
    CHECK (edge_type IN (
        -- original types
        'contains',
        'extracted_from',
        'references',
        'cites',
        'produced_by',
        'influenced_by',
        'derived_from',
        'co_occurs_with',
        'is_type',
        'has_feedback',
        'version_of',
        -- latent types already used in code (fixing constraint gap)
        'described_in',
        'has_variable',
        'uses_codelist',
        'has_term',
        -- new
        'used_in_decision',   -- chunk/entity → decision  (what context was consumed)
        'corrects'            -- correction node → decision node
    ));

-- ─── 2. Expand context_nodes node_type CHECK ─────────────────────────────────

ALTER TABLE context_nodes
    DROP CONSTRAINT IF EXISTS context_nodes_node_type_check;

ALTER TABLE context_nodes
    ADD CONSTRAINT context_nodes_node_type_check
    CHECK (node_type IN (
        -- original types
        'document',
        'chunk',
        'entity',
        'concept',
        'agent_run',
        'decision',
        'feedback',
        'sdtm_domain',
        'sdtm_variable',
        'codelist',
        'codelist_term',
        -- new
        'mistake',      -- agent mistake (alternate node_type when mistake_type is set)
        'correction'    -- user correction artifact (permanent, 21 CFR Part 11 record)
    ));

-- ─── 3. Extend decision_traces ───────────────────────────────────────────────

ALTER TABLE decision_traces
    ADD COLUMN IF NOT EXISTS mistake_type  TEXT;
    -- NULL = not a mistake
    -- 'hallucination' | 'wrong_source' | 'scope_violation' | 'other'

ALTER TABLE decision_traces
    ADD COLUMN IF NOT EXISTS graph_node_id UUID REFERENCES context_nodes(id);
    -- back-link to the 'decision' or 'mistake' node in context_nodes

-- ─── 4. document_index_state — track indexing drift per document ──────────────

CREATE TABLE IF NOT EXISTS document_index_state (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id          UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    org_id               UUID        NOT NULL REFERENCES organizations(id),
    indexed_chunks_count INTEGER     NOT NULL DEFAULT 0,
    total_chunks_count   INTEGER     NOT NULL DEFAULT 0,
    drift_score          FLOAT       NOT NULL DEFAULT 0.0,
        -- (total_chunks - indexed_chunks) / total_chunks; 0 = fully indexed
    needs_reindex        BOOLEAN     NOT NULL DEFAULT FALSE,
        -- TRUE when drift_score > 0.2 (>20% of chunks not in graph)
    last_checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_indexed_at      TIMESTAMPTZ,
    UNIQUE (document_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_index_state_org
    ON document_index_state (org_id)
    WHERE needs_reindex = TRUE;

-- ─── 5. entity_canonical_map — normalize entity names ────────────────────────

CREATE TABLE IF NOT EXISTS entity_canonical_map (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID        NOT NULL REFERENCES organizations(id),
    canonical_form  TEXT        NOT NULL,   -- e.g. "Adverse Event"
    entity_type     TEXT        NOT NULL,   -- e.g. "sdtm_domain"
    aliases         TEXT[]      NOT NULL DEFAULT '{}',
        -- e.g. ARRAY['AE', 'ae', 'adverse events', 'AEs']
    concept_node_id UUID        REFERENCES context_nodes(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (org_id, canonical_form, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_canonical_org
    ON entity_canonical_map (org_id, entity_type);

-- Seed SDTM domain aliases per existing org
INSERT INTO entity_canonical_map (org_id, canonical_form, entity_type, aliases)
SELECT
    o.id,
    c.canonical_form,
    c.entity_type,
    c.aliases
FROM organizations o
CROSS JOIN (VALUES
    ('Adverse Event',            'sdtm_domain', ARRAY['AE','ae','adverse events','AEs','adverse event']),
    ('Laboratory Test Results',  'sdtm_domain', ARRAY['LB','lb','lab','labs','laboratory']),
    ('Vital Signs',              'sdtm_domain', ARRAY['VS','vs','vitals','vital signs']),
    ('Demographics',             'sdtm_domain', ARRAY['DM','dm','demographics','demography']),
    ('Subject Visits',           'sdtm_domain', ARRAY['SV','sv','visits','visit schedule']),
    ('Concomitant Medications',  'sdtm_domain', ARRAY['CM','cm','conmeds','concomitant meds','concomitant medications']),
    ('Exposure',                 'sdtm_domain', ARRAY['EX','ex','dosing','exposure']),
    ('Tumor Results',            'sdtm_domain', ARRAY['TR','tr','tumor','tumour']),
    ('Overall Survival',         'sdtm_domain', ARRAY['OS','overall survival','survival']),
    ('Primary Endpoint',         'clinical_concept', ARRAY['primary endpoint','primary efficacy','primary outcome']),
    ('Informed Consent',         'clinical_concept', ARRAY['ICF','icf','informed consent','consent'])
) AS c(canonical_form, entity_type, aliases)
ON CONFLICT (org_id, canonical_form, entity_type) DO NOTHING;

-- ─── 6. context_pack_log — cache metadata for deterministic context packs ─────
-- Actual pack bytes live in Redis; this table provides audit trail + debug info.

CREATE TABLE IF NOT EXISTS context_pack_log (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pack_hash       TEXT        NOT NULL,
        -- SHA-256 of "{org_id}:{study_id}:{sorted_chunk_ids}"
    org_id          UUID        NOT NULL REFERENCES organizations(id),
    study_id        UUID        REFERENCES studies(id),
    agent_run_id    UUID        REFERENCES agent_runs(id),
    query_text      TEXT        NOT NULL,
    chunk_ids       UUID[]      NOT NULL DEFAULT '{}',
    token_count     INTEGER,
    scope_policy    JSONB       NOT NULL DEFAULT '{}',
        -- serialized ScopePolicy (non-sensitive summary)
    cache_hit       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pack_hash, org_id)
);

CREATE INDEX IF NOT EXISTS idx_pack_log_org
    ON context_pack_log (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pack_log_hash
    ON context_pack_log (pack_hash);

-- ─── 7. Index on used_in_decision edges for fast reverse traversal ────────────
-- (The forward index idx_ctx_edges_source already covers source→target lookups)

CREATE INDEX IF NOT EXISTS idx_ctx_edges_used_in_decision
    ON context_edges (target_node_id, edge_type)
    WHERE edge_type = 'used_in_decision';

-- ─── 8. Index on decision_traces for scope-based bias resolution ─────────────

CREATE INDEX IF NOT EXISTS idx_decision_traces_org_study
    ON decision_traces (org_id, study_id, created_at DESC)
    WHERE agent_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_decision_traces_graph_node
    ON decision_traces (graph_node_id)
    WHERE graph_node_id IS NOT NULL;
