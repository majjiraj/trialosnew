-- Migration 024: Study Graph (Layer 2 — Client-Specific Knowledge Graphs)
-- PostgreSQL mirrors of Neo4j study design nodes, decision memory, and issue/risk registry.

CREATE TABLE IF NOT EXISTS study_design_elements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_id        UUID NOT NULL REFERENCES studies(id),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    element_type    TEXT NOT NULL CHECK (element_type IN (
        -- USDM v4.0 core design classes
        'arm','epoch','cell','element','activity','encounter','schedule_timeline',
        'biomedical_concept','estimand','indication','cohort',
        -- Derived/aggregated types
        'endpoint','eligibility','population',
        -- Data ops / process types
        'data_source','sop','role','vendor','submission'
    )),
    label           TEXT NOT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}',
    neo4j_node_id   TEXT,
    embedding       VECTOR(768),
    source          TEXT NOT NULL DEFAULT 'usdm' CHECK (source IN ('usdm','manual','agent_extracted')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sde_study ON study_design_elements(study_id, element_type);
CREATE INDEX IF NOT EXISTS idx_sde_org ON study_design_elements(org_id);
CREATE INDEX IF NOT EXISTS idx_sde_embedding ON study_design_elements
    USING ivfflat (embedding vector_cosine_ops) WITH (lists=50)
    WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS decision_memory (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    study_id        UUID REFERENCES studies(id),
    category        TEXT NOT NULL CHECK (category IN (
        'override','regulatory_shift','exception',
        'sla_adjustment','mapping_precedent'
    )),
    context_hash    TEXT NOT NULL,
    context_text    TEXT NOT NULL,
    rationale       TEXT NOT NULL,
    impact_domains  TEXT[] NOT NULL DEFAULT '{}',
    approved_by     TEXT,
    approved_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    embedding       VECTOR(768),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, context_hash)
);

CREATE INDEX IF NOT EXISTS idx_dm_org ON decision_memory(org_id, study_id, category);
CREATE INDEX IF NOT EXISTS idx_dm_embedding ON decision_memory
    USING ivfflat (embedding vector_cosine_ops) WITH (lists=50)
    WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS study_issues (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_id        UUID NOT NULL REFERENCES studies(id),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    issue_type      TEXT NOT NULL CHECK (issue_type IN (
        'data_quality','protocol_deviation','sla_breach',
        'regulatory','site_performance','safety'
    )),
    title           TEXT NOT NULL,
    description     TEXT,
    severity        TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
    status          TEXT NOT NULL DEFAULT 'open' CHECK (
        status IN ('open','in_progress','resolved','closed','escalated')
    ),
    related_domain  TEXT,
    assigned_to     TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issues_study ON study_issues(study_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_issues_org ON study_issues(org_id, status);
