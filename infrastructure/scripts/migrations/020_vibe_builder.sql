-- Migration 020: Vibe Builder — add test_cases, execution_type, output_schema, safety_constraints

ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS test_cases JSONB DEFAULT '[]';

ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS test_cases        JSONB   DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS output_schema     JSONB   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS safety_constraints TEXT[] DEFAULT '{}';

-- execution_type needs a CHECK constraint; add column then constraint separately
ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS execution_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_skills_execution_type_check'
  ) THEN
    ALTER TABLE agent_skills
      ADD CONSTRAINT agent_skills_execution_type_check
      CHECK (execution_type IN ('reasoning','query','transformation','tool_call'));
  END IF;
END$$;
