-- Migration 011: Agent Versioning & Lifecycle
-- Adds version snapshots, draft/active/archived status, and updated_by tracking.

-- Extend agent_definitions
ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by  UUID REFERENCES users(id);

-- Full snapshot of each version
CREATE TABLE IF NOT EXISTS agent_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
    version         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'archived')),
    change_type     TEXT NOT NULL DEFAULT 'minor'
                        CHECK (change_type IN ('major', 'minor')),
    change_reason   TEXT NOT NULL DEFAULT '',
    changed_by      UUID REFERENCES users(id),
    -- snapshot columns
    name            TEXT NOT NULL,
    description     TEXT,
    agent_config    JSONB DEFAULT '{}',
    flow_definition JSONB,
    declared_tools  TEXT[] NOT NULL DEFAULT '{}',
    required_permissions TEXT[] NOT NULL DEFAULT '{}',
    agent_mode      TEXT DEFAULT 'standard',
    expertise_scaffold JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_id
    ON agent_versions(agent_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_versions_one_active
    ON agent_versions(agent_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_versions_version_per_agent
    ON agent_versions(agent_id, version);
