-- Migration 028: Enhanced Evaluation (Layer 7)
-- Multi-score framework, benchmarks, drift detection, ground truth progress.

-- Extend run_evaluator_results with multi-score fields
ALTER TABLE run_evaluator_results
    ADD COLUMN IF NOT EXISTS score_breakdown JSONB DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS weighted_score FLOAT,
    ADD COLUMN IF NOT EXISTS weight_config JSONB DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS acceptance_decision TEXT
        CHECK (acceptance_decision IN ('auto_approved','escalated','hitl_required')),
    ADD COLUMN IF NOT EXISTS false_confidence_detected BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS false_confidence_details JSONB DEFAULT '{}';

-- Ground truth benchmarks per task type
CREATE TABLE IF NOT EXISTS evaluation_benchmarks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID REFERENCES organizations(id),
    task_type       TEXT NOT NULL,
    benchmark_name  TEXT NOT NULL,
    input_example   JSONB NOT NULL DEFAULT '{}',
    expected_output JSONB NOT NULL DEFAULT '{}',
    gold_scores     JSONB NOT NULL DEFAULT '{}',
    source          TEXT CHECK (source IN ('human_expert','cdisc_spec','regulatory_guidance','synthetic')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(task_type, benchmark_name, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
);

CREATE INDEX IF NOT EXISTS idx_benchmarks_task ON evaluation_benchmarks(task_type, is_active);

-- Drift detection snapshots (7-day rolling)
CREATE TABLE IF NOT EXISTS evaluation_drift_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    evaluator_id    UUID NOT NULL REFERENCES evaluator_definitions(id),
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    avg_score       FLOAT NOT NULL,
    score_stddev    FLOAT NOT NULL,
    run_count       INT NOT NULL DEFAULT 0,
    drift_detected  BOOLEAN NOT NULL DEFAULT FALSE,
    drift_magnitude FLOAT,
    baseline_avg    FLOAT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, evaluator_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_drift_org ON evaluation_drift_snapshots(org_id, evaluator_id, period_start DESC);

-- Ground truth coverage progress per task type
CREATE TABLE IF NOT EXISTS ground_truth_progress (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id),
    task_type       TEXT NOT NULL,
    total_benchmarks INT NOT NULL DEFAULT 0,
    verified_count  INT NOT NULL DEFAULT 0,
    coverage_pct    FLOAT,
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, task_type)
);
