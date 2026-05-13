-- Track the top-level super-agent orchestration plan that initiated each USDM conversion.
-- run_id continues to hold the sub-agent agent_run.id; plan_id holds the L4 orchestration plan.
ALTER TABLE usdm_conversions
ADD COLUMN IF NOT EXISTS plan_id TEXT;

CREATE INDEX IF NOT EXISTS usdm_conversions_plan_idx ON usdm_conversions(plan_id);
