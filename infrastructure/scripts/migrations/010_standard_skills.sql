-- Migration 010: Standard Skills (platform-level, publishable)

-- Allow platform-level skills (org_id IS NULL)
ALTER TABLE agent_skills ALTER COLUMN org_id DROP NOT NULL;

-- UNIQUE(org_id, name) fails with NULLs — replace with partial indexes
ALTER TABLE agent_skills DROP CONSTRAINT IF EXISTS agent_skills_org_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_org_name      ON agent_skills(org_id, name) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_platform_name ON agent_skills(name)         WHERE org_id IS NULL;

-- Publish lifecycle columns
ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES users(id);

-- Fast lookup: published standard skills
CREATE INDEX IF NOT EXISTS idx_skills_standard_published
  ON agent_skills(is_published) WHERE org_id IS NULL;
