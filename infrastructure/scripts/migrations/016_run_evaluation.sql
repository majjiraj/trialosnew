-- Migration 016: Agent run evaluation & session tracking
-- Adds session_id, metrics columns to agent_runs, and new agent_run_evaluations table

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS session_id UUID DEFAULT gen_random_uuid();
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS turn_count INT DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tool_calls_total INT DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS tool_calls_successful INT DEFAULT 0;

CREATE TABLE IF NOT EXISTS agent_run_evaluations (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                UUID REFERENCES agent_runs(id) ON DELETE CASCADE,
    session_id            UUID,
    org_id                UUID NOT NULL,
    task_completed        BOOLEAN,
    turn_count            INT,
    latency_ms            INT,
    cost_usd              FLOAT,
    tool_calls_total      INT,
    tool_calls_successful INT,
    tool_usage_accuracy   FLOAT,
    faithfulness_score    FLOAT,
    reasoning_score       FLOAT,
    hallucination_detected BOOLEAN DEFAULT FALSE,
    hallucination_rate    FLOAT DEFAULT 0,
    judge_model           TEXT,
    judge_verdict         TEXT CHECK (judge_verdict IN ('pass','partial','fail','unknown')),
    judge_notes           TEXT,
    evaluator             TEXT DEFAULT 'auto',
    evaluated_at          TIMESTAMPTZ DEFAULT NOW(),
    created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_run_id     ON agent_run_evaluations(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_session_id ON agent_run_evaluations(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_session_id ON agent_runs(session_id);
