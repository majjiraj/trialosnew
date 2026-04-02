-- Migration 019: USDM draft status + nullable protocol_doc_id
-- Allows creating a draft conversion before the user selects a protocol document.

-- 1. Allow protocol_doc_id to be NULL (draft conversions have no doc yet)
ALTER TABLE usdm_conversions ALTER COLUMN protocol_doc_id DROP NOT NULL;

-- 2. Add 'selecting_document' to allowed statuses
ALTER TABLE usdm_conversions DROP CONSTRAINT IF EXISTS usdm_conversions_status_check;
ALTER TABLE usdm_conversions ADD CONSTRAINT usdm_conversions_status_check
    CHECK (status IN (
        'selecting_document',   -- HITL step 1: waiting for user to choose a protocol
        'pending','running','waiting_approval',
        'approved','rejected','completed','failed'
    ));
