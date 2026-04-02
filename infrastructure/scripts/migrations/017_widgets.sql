-- 017_widgets.sql
-- Widget Maker: widgets, dashboards, dashboard_placements

CREATE TABLE IF NOT EXISTS widgets (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         UUID NOT NULL REFERENCES organizations(id),
    study_id       TEXT,
    name           TEXT NOT NULL,
    description    TEXT DEFAULT '',
    chart_type     TEXT NOT NULL CHECK (chart_type IN ('line','bar','pie','scatter','area','heatmap')),
    echarts_config JSONB NOT NULL DEFAULT '{}',
    data_source    JSONB DEFAULT '{}',
    created_by     TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dashboards (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     UUID NOT NULL REFERENCES organizations(id),
    study_id   TEXT,
    name       TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dashboard_placements (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    widget_id    UUID NOT NULL REFERENCES widgets(id) ON DELETE CASCADE,
    pos_x        INT DEFAULT 0,
    pos_y        INT DEFAULT 0,
    width        INT DEFAULT 6,
    height       INT DEFAULT 4,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_widgets_org ON widgets(org_id);
CREATE INDEX IF NOT EXISTS idx_dashboards_org ON dashboards(org_id);
CREATE INDEX IF NOT EXISTS idx_placements_dashboard ON dashboard_placements(dashboard_id);
