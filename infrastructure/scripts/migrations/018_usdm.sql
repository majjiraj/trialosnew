-- 018_usdm.sql
-- USDM Protocol Converter: stores conversion jobs and USDM v4 output

CREATE TABLE IF NOT EXISTS usdm_conversions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID NOT NULL REFERENCES organizations(id),
    study_id            TEXT,
    -- source protocol document
    protocol_doc_id     TEXT NOT NULL,
    protocol_filename   TEXT NOT NULL DEFAULT '',
    protocol_s3_key     TEXT NOT NULL DEFAULT '',
    -- output
    name                TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','running','waiting_approval',
                                              'approved','rejected','completed','failed')),
    usdm_json           JSONB DEFAULT '{}',
    -- links
    run_id              TEXT,          -- agent_runs.id
    approval_id         UUID,          -- approval_requests.id (set when waiting_approval)
    -- meta
    created_by          TEXT,
    error_message       TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usdm_conversions_org_idx      ON usdm_conversions(org_id);
CREATE INDEX IF NOT EXISTS usdm_conversions_status_idx   ON usdm_conversions(status);
CREATE INDEX IF NOT EXISTS usdm_conversions_study_idx    ON usdm_conversions(study_id);

-- Trigger: keep updated_at current
CREATE OR REPLACE FUNCTION usdm_conversions_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS usdm_conversions_updated_at ON usdm_conversions;
CREATE TRIGGER usdm_conversions_updated_at
    BEFORE UPDATE ON usdm_conversions
    FOR EACH ROW EXECUTE FUNCTION usdm_conversions_set_updated_at();

-- Extend agent_type check constraint to include usdm_converter
ALTER TABLE agent_definitions DROP CONSTRAINT IF EXISTS agent_definitions_agent_type_check;
ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_agent_type_check
  CHECK (agent_type = ANY (ARRAY['docker','config-driven','prompt-agent','langchain-flow','sdtm_mapper','usdm_converter']));

-- Insert the built-in USDM converter agent definition if not already present
INSERT INTO agent_definitions
    (id, name, slug, version, category, description, agent_type, agent_purpose,
     is_published, is_verified, publisher_type)
VALUES
    ('00000000-0000-0000-0000-000000000004',
     'Protocol to USDM 4 Converter',
     'protocol-usdm-converter',
     '1.0.0',
     'protocol',
     'Converts a clinical trial protocol document into USDM v4 (Unified Study Definition Model) JSON. Uses the USDM implementation guide from the knowledge graph. Includes a human-in-the-loop review step.',
     'usdm_converter',
     'protocol_writing',
     true,
     true,
     'trialo-native')
ON CONFLICT (id) DO NOTHING;
