-- Migration: 001_initial_schema
-- Description: Apply the full TrialOS initial database schema.
-- This migration delegates to init-db.sql via \i.
-- NOTE: The migrate.sh script applies init-db.sql separately (as migration 000).
--       This file exists as an explicit migration record and applies any
--       schema elements that were added after the initial init.

-- If init-db.sql has not been applied via migrate.sh's init phase
-- (e.g., in a fresh environment using only the migrations runner),
-- uncomment the line below:
-- \i /app/infrastructure/scripts/init-db.sql

-- Add any supplemental schema or index changes introduced alongside the
-- initial schema here. These are idempotent (IF NOT EXISTS / IF EXISTS guards).

-- Ensure pgvector extension is enabled (safe to re-run)
CREATE EXTENSION IF NOT EXISTS "vector";

-- Ensure uuid-ossp is enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Ensure pgcrypto is enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Add composite index for agent_runs lookup by org (via installation join)
CREATE INDEX IF NOT EXISTS idx_runs_created_at
    ON agent_runs (created_at DESC);

-- Add index for approval_requests lookup by org
CREATE INDEX IF NOT EXISTS idx_approvals_org_status
    ON approval_requests (org_id, status, created_at DESC);

-- Add index for lab_report_ingestions needing review
CREATE INDEX IF NOT EXISTS idx_lab_reports_needs_review
    ON lab_report_ingestions (needs_review, created_at DESC)
    WHERE needs_review = TRUE;

-- Add index for edc_connections that are active
CREATE INDEX IF NOT EXISTS idx_edc_connections_active
    ON edc_connections (study_id, is_active, last_sync_at)
    WHERE is_active = TRUE;

-- Track schema_version in a simple metadata table
CREATE TABLE IF NOT EXISTS schema_metadata (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    set_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_metadata (key, value)
    VALUES ('schema_version', '001')
    ON CONFLICT (key) DO UPDATE
        SET value  = EXCLUDED.value,
            set_at = NOW();
