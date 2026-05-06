-- Migration 032 — Protocol Intelligence Hub
-- Adds study_protocols association table and observability columns on usdm_conversions.

CREATE TABLE IF NOT EXISTS study_protocols (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    study_id      TEXT NOT NULL,
    document_id   UUID REFERENCES documents(id) ON DELETE SET NULL,
    name          TEXT NOT NULL DEFAULT '',
    version       TEXT NOT NULL DEFAULT '1.0',
    is_active     BOOLEAN NOT NULL DEFAULT true,
    uploaded_by   TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sp_org_study ON study_protocols(org_id, study_id);
CREATE INDEX IF NOT EXISTS sp_doc       ON study_protocols(document_id);

CREATE OR REPLACE FUNCTION study_protocols_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS study_protocols_updated_at ON study_protocols;
CREATE TRIGGER study_protocols_updated_at
    BEFORE UPDATE ON study_protocols
    FOR EACH ROW EXECUTE FUNCTION study_protocols_set_updated_at();

-- Observability columns on usdm_conversions (idempotent)
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS client_graph_built      BOOLEAN DEFAULT false;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS client_graph_node_count INT     DEFAULT 0;
ALTER TABLE usdm_conversions ADD COLUMN IF NOT EXISTS observe_summary         JSONB;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('032_protocol_hub', NOW())
ON CONFLICT (version) DO NOTHING;
