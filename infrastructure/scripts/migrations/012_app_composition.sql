-- Migration 012: Application Composition Platform (ACP)
-- Adds all tables for app definitions, versions, installations, workflow instances,
-- tasks, electronic signatures, agent attachments, and agent run links.

-- ─── App Definitions ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_definitions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL,
    version             TEXT NOT NULL DEFAULT '1.0.0',
    description         TEXT,
    category            TEXT NOT NULL DEFAULT 'clinical',
    bpmn_xml            TEXT,
    form_ids            JSONB NOT NULL DEFAULT '[]',
    agent_attachments   JSONB NOT NULL DEFAULT '[]',
    settings            JSONB NOT NULL DEFAULT '{}',
    status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'active', 'under_review', 'published', 'deprecated')),
    is_published        BOOLEAN NOT NULL DEFAULT FALSE,
    publisher_org_id    UUID REFERENCES organizations(id),
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ,
    updated_by          UUID REFERENCES users(id),
    UNIQUE (org_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_app_definitions_org_id
    ON app_definitions(org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_definitions_published
    ON app_definitions(is_published, status)
    WHERE is_published = TRUE;

-- ─── App Versions ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id          UUID NOT NULL REFERENCES app_definitions(id) ON DELETE CASCADE,
    version         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'archived')),
    change_type     TEXT NOT NULL DEFAULT 'minor'
                        CHECK (change_type IN ('major', 'minor', 'patch')),
    change_reason   TEXT NOT NULL DEFAULT '',
    changed_by      UUID REFERENCES users(id),
    -- snapshot columns
    name            TEXT NOT NULL,
    description     TEXT,
    bpmn_xml        TEXT,
    form_ids        JSONB NOT NULL DEFAULT '[]',
    agent_attachments JSONB NOT NULL DEFAULT '[]',
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_versions_app_id
    ON app_versions(app_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_versions_one_active
    ON app_versions(app_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_versions_version
    ON app_versions(app_id, version);

-- ─── App Installations ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_installations (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    app_id                  UUID NOT NULL REFERENCES app_definitions(id),
    installed_version       TEXT NOT NULL,
    installed_by            UUID REFERENCES users(id),
    zeebe_deployment_key    BIGINT,
    custom_config           JSONB NOT NULL DEFAULT '{}',
    consented_permissions   TEXT[] NOT NULL DEFAULT '{}',
    status                  TEXT NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'suspended', 'uninstalled')),
    installed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_installs
    ON app_installations(org_id, app_id)
    WHERE status != 'uninstalled';

CREATE INDEX IF NOT EXISTS idx_app_installations_org_id
    ON app_installations(org_id, status);

-- ─── Workflow Instances ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_instances (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    installation_id     UUID REFERENCES app_installations(id),
    app_id              UUID REFERENCES app_definitions(id),
    study_id            TEXT,
    zeebe_instance_key  BIGINT,
    bpmn_process_id     TEXT,
    status              TEXT NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running', 'completed', 'terminated', 'incident', 'waiting_approval')),
    input_variables     JSONB NOT NULL DEFAULT '{}',
    output_variables    JSONB NOT NULL DEFAULT '{}',
    sla_deadline        TIMESTAMPTZ,
    started_by          UUID REFERENCES users(id),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_org_id
    ON workflow_instances(org_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_installation
    ON workflow_instances(installation_id);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_zeebe_key
    ON workflow_instances(zeebe_instance_key);

-- ─── Workflow Tasks ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_tasks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    instance_id         UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
    zeebe_job_key       BIGINT,
    element_id          TEXT,
    element_name        TEXT,
    form_id             TEXT,
    assignee_id         UUID REFERENCES users(id),
    assignee_role       TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'claimed', 'completed', 'escalated', 'cancelled')),
    due_date            TIMESTAMPTZ,
    claimed_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    completion_data     JSONB NOT NULL DEFAULT '{}',
    esignature_id       UUID,  -- FK added after electronic_signatures table
    variables           JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_instance
    ON workflow_tasks(instance_id, status);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_assignee
    ON workflow_tasks(assignee_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_org_status
    ON workflow_tasks(org_id, status, due_date ASC);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_zeebe_job
    ON workflow_tasks(zeebe_job_key);

-- ─── Electronic Signatures (21 CFR Part 11) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS electronic_signatures (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    resource_type   TEXT NOT NULL,   -- 'workflow_task', 'form_submission', 'app_version'
    resource_id     UUID NOT NULL,
    signer_id       UUID NOT NULL REFERENCES users(id),
    meaning         TEXT NOT NULL,   -- e.g. "I approve this SAE report"
    auth_method     TEXT NOT NULL DEFAULT 'password'
                        CHECK (auth_method IN ('password', 'mfa', 'pki')),
    content_hash    TEXT NOT NULL,   -- SHA-256 of resource state at signing
    audit_event_id  UUID,            -- FK to audit_events (chained)
    signed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_esig_resource
    ON electronic_signatures(resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_esig_signer
    ON electronic_signatures(signer_id, signed_at DESC);

-- Back-fill FK from workflow_tasks to electronic_signatures
ALTER TABLE workflow_tasks
    ADD CONSTRAINT fk_workflow_tasks_esig
    FOREIGN KEY (esignature_id) REFERENCES electronic_signatures(id);

-- ─── App Agent Attachments ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_agent_attachments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id              UUID NOT NULL REFERENCES app_definitions(id) ON DELETE CASCADE,
    step_id             TEXT NOT NULL,    -- BPMN element id
    agent_def_id        UUID NOT NULL REFERENCES agent_definitions(id),
    trigger_mode        TEXT NOT NULL DEFAULT 'always'
                            CHECK (trigger_mode IN ('always', 'conditional', 'manual')),
    trigger_condition   JSONB,            -- FEEL expression when conditional
    agent_config        JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (app_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_app_agent_attachments_app
    ON app_agent_attachments(app_id);

-- ─── Workflow Agent Runs ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflow_agent_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    instance_id     UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
    task_id         UUID REFERENCES workflow_tasks(id),
    agent_run_id    UUID REFERENCES agent_runs(id),
    step_id         TEXT,
    agent_def_id    UUID REFERENCES agent_definitions(id),
    input_vars      JSONB NOT NULL DEFAULT '{}',
    output_vars     JSONB NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_agent_runs_instance
    ON workflow_agent_runs(instance_id);

CREATE INDEX IF NOT EXISTS idx_workflow_agent_runs_agent_run
    ON workflow_agent_runs(agent_run_id);
