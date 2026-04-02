-- Migration 022: Comprehensive Evaluator System
-- Adds evaluator_definitions and run_evaluator_results tables

CREATE TABLE IF NOT EXISTS evaluator_definitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID,                  -- NULL = built-in (global)
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,
    description     TEXT,
    category        TEXT NOT NULL,         -- quality|safety|compliance|custom
    evaluator_type  TEXT NOT NULL,         -- llm_judge|rule_based|threshold|custom_prompt
    config          JSONB NOT NULL DEFAULT '{}',
    -- config schema per type:
    --   llm_judge:    { prompt_template, scoring_dimensions, model?, temperature? }
    --   rule_based:   { rules: [{field, operator, value, score_if_true}] }
    --   threshold:    { metric, min_value, max_value }
    --   custom_prompt: { system_prompt, user_prompt_template, output_format }
    is_builtin      BOOLEAN DEFAULT FALSE,
    is_active       BOOLEAN DEFAULT TRUE,
    langfuse_score_name TEXT,             -- score name to use when writing to Langfuse
    created_by      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evaluator_slug_org
    ON evaluator_definitions(slug, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_evaluator_org ON evaluator_definitions(org_id);

CREATE TABLE IF NOT EXISTS run_evaluator_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    evaluator_id    UUID NOT NULL REFERENCES evaluator_definitions(id) ON DELETE CASCADE,
    org_id          UUID NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','completed','failed')),
    score           FLOAT,                 -- normalized 0.0-1.0
    verdict         TEXT CHECK (verdict IN ('pass','partial','fail','unknown')),
    details         JSONB DEFAULT '{}',    -- full breakdown per dimension
    notes           TEXT,
    error_message   TEXT,
    judge_model     TEXT,
    triggered_by    TEXT,                  -- 'auto' | user_id
    langfuse_score_id TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_reval_run_id ON run_evaluator_results(run_id);
CREATE INDEX IF NOT EXISTS idx_reval_evaluator ON run_evaluator_results(evaluator_id);
