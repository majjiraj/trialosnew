-- Migration 009: DeepAgent capabilities
-- Skills: org-scoped reusable capabilities
CREATE TABLE IF NOT EXISTS agent_skills (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    skill_type   TEXT NOT NULL DEFAULT 'function',   -- function | prompt
    body         TEXT NOT NULL,                      -- Python code or prompt template
    input_schema JSONB NOT NULL DEFAULT '{}',
    tags         TEXT[] NOT NULL DEFAULT '{}',
    created_by   UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skills_org ON agent_skills(org_id);

-- Memory: persistent cross-run key-value store per agent+study
CREATE TABLE IF NOT EXISTS agent_memory (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_definition_id   UUID NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
    study_id              UUID REFERENCES studies(id) ON DELETE CASCADE,  -- NULL = agent-global
    memory_key            TEXT NOT NULL,
    memory_value          JSONB NOT NULL,
    written_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    written_by_run        UUID REFERENCES agent_runs(id),
    UNIQUE(org_id, agent_definition_id, study_id, memory_key)
);
CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agent_definition_id, study_id);

-- Expertise scaffold column on agent_definitions
-- Shape: { role, domain, constraints: [...], reasoning_style, output_format }
ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS expertise_scaffold JSONB;
