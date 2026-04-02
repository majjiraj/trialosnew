-- Migration 013: Change study_id columns from UUID to TEXT system-wide
-- Allows plain string study identifiers (e.g. "S123", "STUDY001") used in SDTM workflows
-- Also relaxes uploaded_by FK so internal service uploads don't require a users row

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_study_id_fkey;
ALTER TABLE documents ALTER COLUMN study_id TYPE TEXT USING study_id::text;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_uploaded_by_fkey;
ALTER TABLE documents ALTER COLUMN uploaded_by TYPE TEXT USING uploaded_by::text;

ALTER TABLE document_chunks DROP CONSTRAINT IF EXISTS document_chunks_study_id_fkey;
ALTER TABLE document_chunks ALTER COLUMN study_id TYPE TEXT USING study_id::text;

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_study_id_fkey;
ALTER TABLE agent_runs ALTER COLUMN study_id TYPE TEXT USING study_id::text;

ALTER TABLE decision_traces DROP CONSTRAINT IF EXISTS decision_traces_study_id_fkey;
ALTER TABLE decision_traces ALTER COLUMN study_id TYPE TEXT USING study_id::text;

ALTER TABLE agent_memory DROP CONSTRAINT IF EXISTS agent_memory_study_id_fkey;
ALTER TABLE agent_memory ALTER COLUMN study_id TYPE TEXT USING study_id::text;

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_study_id_fkey;
ALTER TABLE approval_requests ALTER COLUMN study_id TYPE TEXT USING study_id::text;

ALTER TABLE context_nodes DROP CONSTRAINT IF EXISTS context_nodes_study_id_fkey;
ALTER TABLE context_nodes ALTER COLUMN study_id TYPE TEXT USING study_id::text;

ALTER TABLE context_index DROP CONSTRAINT IF EXISTS context_index_study_id_fkey;
ALTER TABLE context_index ALTER COLUMN study_id TYPE TEXT USING study_id::text;

ALTER TABLE agent_triggers DROP CONSTRAINT IF EXISTS agent_triggers_study_id_fkey;
ALTER TABLE agent_triggers ALTER COLUMN study_id TYPE TEXT USING study_id::text;

ALTER TABLE lineage_records DROP CONSTRAINT IF EXISTS lineage_records_study_id_fkey;
ALTER TABLE lineage_records ALTER COLUMN study_id TYPE TEXT USING study_id::text;

ALTER TABLE data_queries DROP CONSTRAINT IF EXISTS data_queries_study_id_fkey;
ALTER TABLE data_queries ALTER COLUMN study_id TYPE TEXT USING study_id::text;
