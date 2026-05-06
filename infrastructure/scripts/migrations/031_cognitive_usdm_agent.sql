-- Migration 031 — Protocol-to-USDM Cognitive Agent (L5.E1)
-- Registers the cognitive agent and adds evaluator score columns to usdm_conversions.

-- Extend agent_type check to include 'cognitive_usdm'
ALTER TABLE agent_definitions DROP CONSTRAINT IF EXISTS agent_definitions_agent_type_check;
ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_agent_type_check
  CHECK (agent_type = ANY (ARRAY[
    'docker','config-driven','prompt-agent','langchain-flow',
    'sdtm_mapper','usdm_converter','trialo_native','cognitive_usdm'
  ]));

-- Add per-evaluator score columns to usdm_conversions (L5.E11–E17)
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS eval_accuracy      FLOAT;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS eval_completeness  FLOAT;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS eval_standards     FLOAT;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS eval_hallucination FLOAT;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS eval_readability   FLOAT;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS eval_consistency   FLOAT;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS eval_cost_usd      FLOAT;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS confidence         FLOAT;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS retry_count        INT DEFAULT 0;

-- Register the cognitive agent in agent_definitions
INSERT INTO agent_definitions
    (id, name, slug, version, category, description, agent_type, agent_purpose,
     is_published, is_verified, publisher_type, accuracy_rate, reputation_score, avg_latency_ms)
VALUES
    ('00000000-0000-0000-0000-000000000020',
     'Protocol to USDM Cognitive Agent',
     'protocol-usdm-cognitive',
     '1.0.0',
     'protocol',
     'Cognitive L5.E1 agent: converts clinical trial protocol documents to USDM v4.0 JSON '
     'with 7 inline evaluators (accuracy, completeness, standards, hallucination, readability, '
     'cost, consistency), a 5-level retry tree, and self-learning memory write-back after every run.',
     'cognitive_usdm',
     'protocol_writing',
     true,
     true,
     'trialo-native',
     0.85,
     0.80,
     5000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('031_cognitive_usdm_agent', NOW())
ON CONFLICT (version) DO NOTHING;
