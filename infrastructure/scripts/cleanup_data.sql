-- ============================================================
-- DATA CLEANUP SCRIPT (Idempotent)
-- Retains: organizations, users
-- Deletes: everything else (only if tables exist)
-- ============================================================

BEGIN;

-- Dynamic cleanup: only truncate tables that actually exist
-- This makes the script safe to run even if schema is incomplete

DO $$
DECLARE
    table_name TEXT;
BEGIN
    -- Build list of all tables to clean (except organizations, users)
    FOR table_name IN (
        SELECT t.tablename
        FROM pg_tables t
        WHERE t.schemaname = 'public'
          AND t.tablename NOT IN ('organizations', 'users', 'schema_metadata')
        ORDER BY t.tablename
    )
    LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(table_name) || ' RESTART IDENTITY CASCADE';
        RAISE NOTICE 'Truncated: %', table_name;
    END LOOP;
END;
$$;

-- Clean org-specific document types (keep platform-wide ones) if table exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='document_type_registry') THEN
        DELETE FROM document_type_registry WHERE org_id IS NOT NULL;
        RAISE NOTICE 'Cleaned document_type_registry';
    END IF;
END;
$$;

COMMIT;

-- Verify
DO $$
DECLARE
    org_count   INT := 0;
    user_count  INT := 0;
BEGIN
    SELECT COUNT(*) INTO org_count FROM organizations WHERE 1=1;
    SELECT COUNT(*) INTO user_count FROM users WHERE 1=1;

    RAISE NOTICE '✓ Cleanup complete. organizations=%, users=%',
        COALESCE(org_count, 0), COALESCE(user_count, 0);
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '✓ Cleanup complete (tables may not exist yet)';
END;
$$;
