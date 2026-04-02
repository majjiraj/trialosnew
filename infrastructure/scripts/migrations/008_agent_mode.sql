-- Migration 008: Add agent_mode column to agent_definitions
-- Supports 'standard' (default) and 'deep' (agents that contain sub-agents)

ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS agent_mode TEXT DEFAULT 'standard';

-- Add comment for documentation
COMMENT ON COLUMN agent_definitions.agent_mode IS 'Agent mode: standard | deep. Deep agents can contain sub-agent nodes in their flow.';
