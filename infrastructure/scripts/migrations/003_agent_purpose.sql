-- Migration 003: extend agent_definitions to support agent purpose, data sources,
-- and LangGraph flow-based agents (flowchart / Flowise-style creation).
-- Idempotent.

-- 1. Add agent_purpose column
ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS agent_purpose TEXT NOT NULL DEFAULT 'custom'
        CHECK (agent_purpose IN (
            'conversational',   -- chat with clinical data / RAG
            'chart_generation', -- visualise data
            'sdtm_mapping',     -- raw EDC → SDTM transformation
            'budget_analysis',  -- study financials
            'protocol_writing', -- create / review protocol documents
            'custom'            -- no specific purpose (wizard free-form or native agents)
        ));

-- 2. Add data_sources array (which data layers the agent may access)
ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS data_sources TEXT[] NOT NULL DEFAULT '{}';

-- 3. Add flow_definition JSONB (nodes + edges for langchain-flow agents)
ALTER TABLE agent_definitions
    ADD COLUMN IF NOT EXISTS flow_definition JSONB;

-- 4. Update agent_type constraint to include 'langchain-flow'
ALTER TABLE agent_definitions
    DROP CONSTRAINT IF EXISTS agent_definitions_agent_type_check;

ALTER TABLE agent_definitions
    ADD CONSTRAINT agent_definitions_agent_type_check
        CHECK (agent_type IN ('docker', 'config-driven', 'prompt-agent', 'langchain-flow'));

-- 5. Index for purpose-based browsing
CREATE INDEX IF NOT EXISTS idx_agent_defs_purpose
    ON agent_definitions (agent_purpose)
    WHERE is_published = TRUE;

-- 6. Record schema version
UPDATE schema_metadata SET schema_version = '003' WHERE id = 1;
