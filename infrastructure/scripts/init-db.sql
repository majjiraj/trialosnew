-- TrialOS PostgreSQL Schema — Core Tables
-- Runs on fresh database initialization

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";  -- pgvector

-- ============================================================
-- ORGANIZATIONS & USERS
-- ============================================================

CREATE TABLE IF NOT EXISTS organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    plan            TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','professional','enterprise')),
    data_region     TEXT NOT NULL DEFAULT 'us' CHECK (data_region IN ('us','eu','apac')),
    stripe_customer_id TEXT,
    settings        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    auth0_user_id   TEXT NOT NULL UNIQUE,
    email           TEXT NOT NULL,
    name            TEXT NOT NULL,
    roles           TEXT[] NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_auth0 ON users(auth0_user_id);

-- ============================================================
-- STUDIES
-- ============================================================

CREATE TABLE IF NOT EXISTS studies (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    name            TEXT NOT NULL,
    protocol_number TEXT NOT NULL,
    phase           TEXT CHECK (phase IN ('I','II','III','IV','Observational')),
    therapeutic_area TEXT,
    indication      TEXT,
    sponsor_name    TEXT,
    status          TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','locked','closed')),
    is_blinded      BOOLEAN NOT NULL DEFAULT FALSE,
    settings        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS study_access (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_id    UUID NOT NULL REFERENCES studies(id),
    user_id     UUID NOT NULL REFERENCES users(id),
    role        TEXT NOT NULL,
    has_unblind BOOLEAN NOT NULL DEFAULT FALSE,
    granted_by  UUID REFERENCES users(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(study_id, user_id)
);

-- ============================================================
-- SITES
-- ============================================================

CREATE TABLE IF NOT EXISTS sites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_id        UUID NOT NULL REFERENCES studies(id),
    site_number     TEXT NOT NULL,
    name            TEXT NOT NULL,
    country         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    principal_investigator TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(study_id, site_number)
);

-- ============================================================
-- EDC CONNECTIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS edc_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_id        UUID NOT NULL REFERENCES studies(id),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    connector_type  TEXT NOT NULL CHECK (connector_type IN ('medidata_rave','redcap','oracle_clinical_one','veeva_vault','castor','file_upload')),
    name            TEXT NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}',  -- encrypted credentials stored separately
    sync_mode       TEXT NOT NULL DEFAULT 'pull' CHECK (sync_mode IN ('pull','push','both')),
    sync_interval_min INT NOT NULL DEFAULT 60,
    last_sync_at    TIMESTAMPTZ,
    last_sync_status TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DOCUMENT INGESTION
-- ============================================================

CREATE TABLE IF NOT EXISTS documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    study_id        UUID REFERENCES studies(id),
    document_type   TEXT NOT NULL CHECK (document_type IN (
                        'protocol','sap','crf','csr','sdtm_ig','adam_ig',
                        'lab_manual','lab_report','study_budget','dmp',
                        'icf','sdtm_dataset','adam_dataset','other'
                    )),
    name            TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    file_size_bytes BIGINT,
    sha256_hash     TEXT NOT NULL,
    version         TEXT NOT NULL DEFAULT '1.0',
    source_type     TEXT NOT NULL DEFAULT 'upload' CHECK (source_type IN ('upload','sftp','url','lims')),
    bronze_s3_key   TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','indexed','error')),
    error_message   TEXT,
    metadata        JSONB DEFAULT '{}',
    uploaded_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docs_study ON documents(study_id, document_type);
CREATE INDEX IF NOT EXISTS idx_docs_org ON documents(org_id, document_type);

-- Lab reports get additional tracking
CREATE TABLE IF NOT EXISTS lab_report_ingestions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id),
    lab_type        TEXT NOT NULL CHECK (lab_type IN ('central','site')),
    site_id         UUID REFERENCES sites(id),
    lab_name        TEXT,
    report_date     DATE,
    subject_count   INT,
    panel_count     INT,
    low_confidence_count INT DEFAULT 0,
    ocr_confidence  FLOAT,  -- NULL for central labs (not needed)
    sdtm_lb_records_created INT DEFAULT 0,
    needs_review    BOOLEAN DEFAULT FALSE,
    reviewed_by     UUID REFERENCES users(id),
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- STUDY BUDGETS
-- ============================================================

CREATE TABLE IF NOT EXISTS site_budgets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_id        UUID NOT NULL REFERENCES studies(id),
    site_id         UUID NOT NULL REFERENCES sites(id),
    cost_category   TEXT NOT NULL,  -- 'per_visit','per_procedure','startup','closeout','overhead'
    period          TEXT NOT NULL,  -- 'YYYY-QN' or 'YYYY-MM'
    budgeted_usd    NUMERIC(12,2) NOT NULL,
    actual_usd      NUMERIC(12,2) DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'USD',
    source_document_id UUID REFERENCES documents(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_milestones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_id        UUID NOT NULL REFERENCES studies(id),
    site_id         UUID NOT NULL REFERENCES sites(id),
    subject_id      TEXT,
    visit_name      TEXT,
    milestone_type  TEXT NOT NULL,  -- 'enrollment','visit','procedure','completion'
    description     TEXT,
    amount_usd      NUMERIC(10,2) NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','earned','invoiced','paid')),
    earned_at       DATE,
    paid_at         DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_milestones_study_site ON payment_milestones(study_id, site_id, status);

-- ============================================================
-- VECTOR STORE (pgvector)
-- ============================================================

CREATE TABLE IF NOT EXISTS document_chunks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES documents(id),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    study_id        UUID REFERENCES studies(id),
    chunk_index     INT NOT NULL,
    page_number     INT,
    section         TEXT,
    content         TEXT NOT NULL,
    embedding       vector(768),  -- nomic-embed-text dimensions
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_study ON document_chunks(study_id, org_id);
-- Vector similarity index (IVFFlat for up to 1M vectors)
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON document_chunks
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================
-- AGENTS & MARKETPLACE
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_definitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    version         TEXT NOT NULL DEFAULT '1.0.0',
    description     TEXT,
    category        TEXT NOT NULL,
    publisher_type  TEXT NOT NULL DEFAULT 'trialo-native' CHECK (publisher_type IN (
                        'trialo-native','verified-third-party','org-custom-sdk','org-created'
                    )),
    publisher_org_id UUID REFERENCES organizations(id),
    agent_type      TEXT NOT NULL DEFAULT 'docker' CHECK (agent_type IN ('docker','config-driven','prompt-agent','langchain-flow','sdtm_mapper')),
    docker_image    TEXT,  -- For docker type agents
    config_schema   JSONB DEFAULT '{}',  -- For config-driven agents
    agent_config    JSONB DEFAULT '{}',  -- For UI-created agents (config-driven)
    required_permissions TEXT[] NOT NULL DEFAULT '{}',
    declared_tools  TEXT[] NOT NULL DEFAULT '{}',
    declared_external_urls TEXT[] DEFAULT '{}',
    agent_purpose   TEXT DEFAULT 'custom',
    data_sources    TEXT[] DEFAULT '{}',
    flow_definition JSONB,               -- For langchain-flow agents
    is_published    BOOLEAN NOT NULL DEFAULT FALSE,
    is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
    changelog       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_installations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    agent_id        UUID NOT NULL REFERENCES agent_definitions(id),
    installed_version TEXT NOT NULL,
    auto_update_patch BOOLEAN NOT NULL DEFAULT TRUE,
    installed_by    UUID NOT NULL REFERENCES users(id),
    consented_permissions TEXT[] NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    installed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, agent_id)
);

CREATE TABLE IF NOT EXISTS agent_triggers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID NOT NULL REFERENCES agent_installations(id),
    study_id        UUID NOT NULL REFERENCES studies(id),
    trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('event','schedule','data_condition','manual')),
    trigger_config  JSONB NOT NULL DEFAULT '{}',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    installation_id UUID NOT NULL REFERENCES agent_installations(id),
    study_id        UUID NOT NULL REFERENCES studies(id),
    trigger_id      UUID REFERENCES agent_triggers(id),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','waiting_approval','completed','failed','cancelled')),
    is_test_run     BOOLEAN NOT NULL DEFAULT FALSE,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    input_context   JSONB DEFAULT '{}',
    output_summary  TEXT,
    artifacts       JSONB DEFAULT '[]',  -- list of {type, s3_key, name}
    error_message   TEXT,
    llm_model       TEXT,
    tokens_used     INT,
    step_traces     JSONB DEFAULT '[]',
    checkpoint_data JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runs_study ON agent_runs(study_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_installation ON agent_runs(installation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS approval_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES agent_runs(id),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    study_id        UUID REFERENCES studies(id),
    assignee_id     TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    proposed_action JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','modified')),
    decision_by     TEXT,
    decision_at     TIMESTAMPTZ,
    decision_note   TEXT,
    modified_action JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DATA LINEAGE
-- ============================================================

CREATE TABLE IF NOT EXISTS lineage_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_record_id    TEXT NOT NULL,
    source_hash         TEXT NOT NULL,
    source_system       TEXT NOT NULL,
    bronze_record_id    TEXT,
    transformation_id   TEXT,
    rule_version        TEXT,
    silver_record_id    TEXT,
    silver_domain       TEXT,
    gold_record_id      TEXT,
    gold_dataset        TEXT,
    transformed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    transformed_by      TEXT NOT NULL DEFAULT 'system',
    approved_by         UUID REFERENCES users(id),
    study_id            UUID NOT NULL REFERENCES studies(id),
    org_id              UUID NOT NULL REFERENCES organizations(id)
);

CREATE INDEX IF NOT EXISTS idx_lineage_source ON lineage_records(source_record_id);
CREATE INDEX IF NOT EXISTS idx_lineage_study ON lineage_records(study_id, org_id);

-- ============================================================
-- QUERIES (Data Queries raised on subject data)
-- ============================================================

CREATE TABLE IF NOT EXISTS data_queries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    study_id        UUID NOT NULL REFERENCES studies(id),
    site_id         UUID REFERENCES sites(id),
    subject_id      TEXT,
    domain          TEXT NOT NULL,  -- AE, LB, VS, etc.
    field_name      TEXT,
    query_text      TEXT NOT NULL,
    raised_by_type  TEXT NOT NULL CHECK (raised_by_type IN ('user','agent')),
    raised_by_id    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed','cancelled')),
    response_text   TEXT,
    responded_by    TEXT,
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at    TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,
    run_id          UUID REFERENCES agent_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_queries_study ON data_queries(study_id, status);
CREATE INDEX IF NOT EXISTS idx_queries_site ON data_queries(site_id, status);
