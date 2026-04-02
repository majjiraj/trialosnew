-- Migration 002: adjust document_chunks.embedding column dimension.
-- Idempotent: no-ops if the current dimension already matches :embedding_dim.
--
-- Usage (called automatically by migrate.sh):
--   psql -v embedding_dim=768 -f 002_embedding_provider.sql

DO $$
DECLARE
    current_dim  INTEGER;
    target_dim   INTEGER := :embedding_dim;
BEGIN
    -- Read current vector dimension from the system catalog.
    SELECT (regexp_matches(format_type(atttypid, atttypmod), 'vector\((\d+)\)'))[1]::INTEGER
      INTO current_dim
      FROM pg_attribute
     WHERE attrelid = 'document_chunks'::regclass
       AND attname   = 'embedding'
       AND attnum    > 0
       AND NOT attisdropped;

    IF current_dim IS NULL THEN
        RAISE NOTICE 'embedding column not found or is not a vector type; skipping migration 002.';
        RETURN;
    END IF;

    IF current_dim = target_dim THEN
        RAISE NOTICE 'embedding dim is already %; no change needed.', current_dim;
        RETURN;
    END IF;

    RAISE NOTICE 'Changing embedding dim from % to % ...', current_dim, target_dim;

    -- Drop the IVFFlat index — ALTER COLUMN TYPE requires the column to be unindexed.
    DROP INDEX IF EXISTS idx_document_chunks_embedding;

    -- Change the column type to the new dimension.
    EXECUTE format(
        'ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector(%s)',
        target_dim
    );

    -- Rebuild the cosine-similarity IVFFlat index.
    EXECUTE format(
        'CREATE INDEX idx_document_chunks_embedding
             ON document_chunks USING ivfflat (embedding vector_cosine_ops)
             WITH (lists = 100)'
    );

    RAISE NOTICE 'embedding dim changed to % and IVFFlat index rebuilt.', target_dim;
END;
$$;
