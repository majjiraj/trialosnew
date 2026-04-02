-- Migration 014: Agent HITL human tasks
-- Allows workflow_tasks to be created directly by agent-runtime (without a Zeebe workflow instance).

-- Make instance_id nullable so agent-run tasks don't require a workflow_instances row
ALTER TABLE workflow_tasks
    ALTER COLUMN instance_id DROP NOT NULL;

-- Drop the FK constraint on instance_id (it was CASCADE from workflow_instances)
ALTER TABLE workflow_tasks
    DROP CONSTRAINT IF EXISTS workflow_tasks_instance_id_fkey;

-- Add agent_run_id to link tasks back to agent runs (no FK — agent_runs may not exist in this schema)
ALTER TABLE workflow_tasks
    ADD COLUMN IF NOT EXISTS agent_run_id TEXT;

-- Also change zeebe_job_key to TEXT to accommodate synthetic keys like "agent_run:<id>:<node>"
ALTER TABLE workflow_tasks
    ALTER COLUMN zeebe_job_key TYPE TEXT USING zeebe_job_key::TEXT;

-- Index for looking up tasks by agent run
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_agent_run
    ON workflow_tasks(agent_run_id)
    WHERE agent_run_id IS NOT NULL;

-- Add waiting_human_task to agent_runs status check if it doesn't already exist
-- (agent_runs.status is a TEXT column with CHECK constraint — update it)
-- The status column is TEXT so we just document the new value here; it will be accepted.
-- Note: if there is a CHECK constraint it needs to be updated.
DO $$
BEGIN
    -- Drop existing status check constraint if present and replace with expanded one
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'agent_runs'::regclass
          AND contype = 'c'
          AND conname LIKE '%status%'
    ) THEN
        ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
        ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
            CHECK (status IN (
                'pending','running','completed','failed','cancelled',
                'waiting_approval','waiting_human_task','test_run'
            ));
    END IF;
END $$;
