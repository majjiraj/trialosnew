-- 007_tenant_graphs.sql
-- Adds org_id to standard_context_graphs for tenant-scoped graphs
-- Run after 006_multitenancy.sql

ALTER TABLE standard_context_graphs
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS idx_scg_org ON standard_context_graphs(org_id);

-- NULL org_id = platform-level (admin-only, visible to all tenants)
-- non-NULL org_id = tenant-scoped (visible only to that tenant)
