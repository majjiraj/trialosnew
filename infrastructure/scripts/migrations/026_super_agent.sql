-- Migration 026: Super Agent (Layer 4 — Orchestration)
-- Orchestration plans, step results, cost budgets.

CREATE TABLE IF NOT EXISTS orchestration_plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    study_id        UUID REFERENCES studies(id),
    intent_text     TEXT NOT NULL,
    intent_class    TEXT NOT NULL,
    plan_definition JSONB NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending','awaiting_approval','running','completed','failed','aborted'
    )),
    zeebe_process_instance_id TEXT,
    initiated_by    TEXT NOT NULL,
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plans_org ON orchestration_plans(org_id, study_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS orchestration_step_results (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id         UUID NOT NULL REFERENCES orchestration_plans(id) ON DELETE CASCADE,
    step_id         TEXT NOT NULL,
    agent_slug      TEXT NOT NULL,
    agent_run_id    UUID REFERENCES agent_runs(id),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending','running','completed','failed','skipped'
    )),
    output_summary  TEXT,
    confidence      FLOAT,
    cost_usd        FLOAT DEFAULT 0,
    tokens_used     INT DEFAULT 0,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(plan_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_step_results_plan ON orchestration_step_results(plan_id);

CREATE TABLE IF NOT EXISTS cost_budgets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    study_id        UUID REFERENCES studies(id),
    budget_type     TEXT NOT NULL CHECK (budget_type IN (
        'daily','weekly','monthly','per_run','per_agent'
    )),
    agent_slug      TEXT,
    budget_usd      FLOAT NOT NULL,
    spent_usd       FLOAT NOT NULL DEFAULT 0,
    period_start    DATE NOT NULL,
    period_end      DATE,
    alert_threshold FLOAT NOT NULL DEFAULT 0.8,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cost_budgets_org ON cost_budgets(org_id, budget_type, period_start);
