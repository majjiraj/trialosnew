-- Migration 030 — Super Agent L4 Enhancement
-- Adds columns required by all 8 L4 engines per Maxis AI Context Layer spec

-- L4.E1: store all 4 intent dimensions
ALTER TABLE orchestration_plans ADD COLUMN IF NOT EXISTS intent_analysis JSONB;
-- L4.E8: store pre-execution gate result
ALTER TABLE orchestration_plans ADD COLUMN IF NOT EXISTS pre_execution_gate JSONB;
-- L4.E5: model strategy summary
ALTER TABLE orchestration_plans ADD COLUMN IF NOT EXISTS model_strategy TEXT;
-- Expose confidence threshold used (from L4.E4)
ALTER TABLE orchestration_plans ADD COLUMN IF NOT EXISTS confidence_threshold FLOAT DEFAULT 0.70;
-- Expose initiated_by already exists; add updated_at if missing
ALTER TABLE orchestration_plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- L4.E6: store per-step confidence gate outcome
ALTER TABLE orchestration_step_results ADD COLUMN IF NOT EXISTS confidence_gate JSONB;
-- L4.E7: store retry history per step
ALTER TABLE orchestration_step_results ADD COLUMN IF NOT EXISTS retry_history JSONB DEFAULT '[]'::jsonb;
-- L4.E5: record which model was selected for this step
ALTER TABLE orchestration_step_results ADD COLUMN IF NOT EXISTS model_selected TEXT;
-- Estimated cost (before execution)
ALTER TABLE orchestration_step_results ADD COLUMN IF NOT EXISTS estimated_cost FLOAT DEFAULT 0;
-- Complexity of this step
ALTER TABLE orchestration_step_results ADD COLUMN IF NOT EXISTS step_complexity TEXT;

-- L5.E20: agent reputation scores (for routing weight in L4.E3)
ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS accuracy_rate FLOAT DEFAULT 0.85;
ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS reputation_score FLOAT DEFAULT 0.80;
ALTER TABLE agent_definitions ADD COLUMN IF NOT EXISTS avg_latency_ms INT DEFAULT 2000;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('030_super_agent_enhanced', NOW())
ON CONFLICT (version) DO NOTHING;
