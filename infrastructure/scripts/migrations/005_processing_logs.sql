CREATE TABLE processing_logs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    org_id      UUID        NOT NULL,
    step        TEXT        NOT NULL,
    -- ingestion | embedding | entity_extraction | graph_build | xpt_graph | indexing
    event       TEXT        NOT NULL,
    -- started | progress | completed | failed
    message     TEXT,
    metadata    JSONB       DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX processing_logs_doc_idx     ON processing_logs(document_id);
CREATE INDEX processing_logs_created_idx ON processing_logs(created_at);
