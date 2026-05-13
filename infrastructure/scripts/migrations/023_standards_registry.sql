-- Migration 023: Standards Registry
-- Foundational Layer (L1) — CDISC CT codelists, standards catalogue,
-- regulatory requirements, temporal timelines, provenance records.

CREATE TABLE IF NOT EXISTS standards_catalogue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    standard_code   TEXT NOT NULL,
    standard_name   TEXT NOT NULL,
    standard_type   TEXT NOT NULL CHECK (standard_type IN (
        'implementation_guide','controlled_terminology',
        'regulatory_guidance','study_design_model','data_standard'
    )),
    version         TEXT NOT NULL,
    effective_date  DATE,
    expiry_date     DATE,
    publisher       TEXT NOT NULL DEFAULT 'CDISC',
    document_url    TEXT,
    s3_key          TEXT,
    org_id          UUID REFERENCES organizations(id),
    metadata        JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(standard_code, version, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
);

CREATE INDEX IF NOT EXISTS idx_standards_code ON standards_catalogue(standard_code);
CREATE INDEX IF NOT EXISTS idx_standards_type ON standards_catalogue(standard_type, is_active);

CREATE TABLE IF NOT EXISTS standards_terminology (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codelist_code   TEXT NOT NULL,
    codelist_name   TEXT NOT NULL,
    standard_id     UUID REFERENCES standards_catalogue(id),
    is_extensible   BOOLEAN NOT NULL DEFAULT FALSE,
    terms           JSONB NOT NULL DEFAULT '[]',
    version         TEXT NOT NULL DEFAULT '2024-09-27',
    submission_value_domain TEXT,
    definition      TEXT,
    embedding       VECTOR(768),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(codelist_code, version)
);

CREATE INDEX IF NOT EXISTS idx_ct_codelist_code ON standards_terminology(codelist_code);
CREATE INDEX IF NOT EXISTS idx_ct_version ON standards_terminology(version);
CREATE INDEX IF NOT EXISTS idx_ct_embedding ON standards_terminology
    USING ivfflat (embedding vector_cosine_ops) WITH (lists=50)
    WHERE embedding IS NOT NULL;

CREATE TABLE IF NOT EXISTS regulatory_requirements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    req_code        TEXT NOT NULL UNIQUE,
    authority       TEXT NOT NULL,
    category        TEXT NOT NULL CHECK (category IN (
        'traceability','audit_trail','data_integrity',
        'submission','validation','safety_reporting','gcp'
    )),
    requirement_text TEXT NOT NULL,
    rationale       TEXT,
    applies_to      TEXT[] NOT NULL DEFAULT '{}',
    effective_date  DATE,
    metadata        JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reg_req_authority ON regulatory_requirements(authority, category);
CREATE INDEX IF NOT EXISTS idx_reg_req_applies ON regulatory_requirements USING GIN(applies_to);

CREATE TABLE IF NOT EXISTS temporal_timelines (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID REFERENCES organizations(id),
    study_id        UUID REFERENCES studies(id),
    timeline_type   TEXT NOT NULL CHECK (timeline_type IN (
        'ct_publication','submission_deadline',
        'regulatory_milestone','ct_expiry','study_milestone'
    )),
    label           TEXT NOT NULL,
    target_date     DATE NOT NULL,
    related_standard_id UUID REFERENCES standards_catalogue(id),
    alert_days_before INT[] NOT NULL DEFAULT '{30,7,1}',
    metadata        JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_timelines_org ON temporal_timelines(org_id, target_date);
CREATE INDEX IF NOT EXISTS idx_timelines_study ON temporal_timelines(study_id, target_date);

CREATE TABLE IF NOT EXISTS provenance_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id     TEXT NOT NULL,
    artifact_type   TEXT NOT NULL,
    org_id          UUID NOT NULL REFERENCES organizations(id),
    study_id        UUID REFERENCES studies(id),
    action          TEXT NOT NULL,
    actor_type      TEXT NOT NULL CHECK (actor_type IN ('agent','human','system','pipeline')),
    actor_id        TEXT NOT NULL,
    parent_artifact_ids TEXT[] NOT NULL DEFAULT '{}',
    model_id        TEXT,
    model_version   TEXT,
    run_id          UUID REFERENCES agent_runs(id),
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provenance_artifact ON provenance_records(artifact_id);
CREATE INDEX IF NOT EXISTS idx_provenance_study ON provenance_records(study_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provenance_org ON provenance_records(org_id, created_at DESC);
