-- 006_multitenancy.sql
-- Adds multi-tenancy support: local auth, platform org, standard context graphs
-- Run after 005_processing_logs.sql

-- ── Local auth support ────────────────────────────────────────────────────────
-- Allow non-Auth0 users (email+bcrypt auth)
ALTER TABLE users ALTER COLUMN auth0_user_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email);

-- ── Org status + platform flag ────────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS is_platform_org BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Platform org (all-zeros UUID = visually distinct "system" org) ─────────────
INSERT INTO organizations (id, name, slug, plan, is_platform_org, status)
VALUES ('00000000-0000-0000-0000-000000000000', 'Trialo Platform', 'trialo-platform', 'enterprise', TRUE, 'active')
ON CONFLICT (id) DO NOTHING;

-- ── Demo tenant org ───────────────────────────────────────────────────────────
INSERT INTO organizations (id, name, slug, plan, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Acme Pharma', 'acme-pharma', 'professional', 'active')
ON CONFLICT (id) DO NOTHING;

-- ── Seed users (password hashes set by seed_passwords.py at deploy time) ─────
-- Platform admin — password: Admin@trialo1
INSERT INTO users (id, org_id, email, name, roles, password_hash, auth0_user_id)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000000',
  'admin@trialo.io',
  'Platform Admin',
  ARRAY['platform_admin'],
  '$2b$12$PLACEHOLDER_ADMIN',
  NULL
) ON CONFLICT (email) DO NOTHING;

-- Demo tenant admin — password: Demo@tenant1
INSERT INTO users (id, org_id, email, name, roles, password_hash, auth0_user_id)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'admin@acme.example',
  'Acme Admin',
  ARRAY['tenant_admin'],
  '$2b$12$PLACEHOLDER_TENANT_ADMIN',
  NULL
) ON CONFLICT (email) DO NOTHING;

-- Demo analyst — password: User@acme1
INSERT INTO users (id, org_id, email, name, roles, password_hash, auth0_user_id)
VALUES (
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000001',
  'analyst@acme.example',
  'Acme Analyst',
  ARRAY['analyst'],
  '$2b$12$PLACEHOLDER_ANALYST',
  NULL
) ON CONFLICT (email) DO NOTHING;

-- ── Standard context graphs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS standard_context_graphs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  description  TEXT,
  document_ids UUID[] NOT NULL DEFAULT '{}',
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  published_by UUID REFERENCES users(id),
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
