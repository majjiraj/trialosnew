-- Migration 027: Enhanced HITL (Layer 6)
-- Reviewer profiles, HITL performance metrics, review divergences.
-- Also extends approval_requests and users tables.

CREATE TABLE IF NOT EXISTS reviewer_profiles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    org_id              UUID NOT NULL REFERENCES organizations(id),
    reviewer_types      TEXT[] NOT NULL DEFAULT '{}',
    domains             TEXT[] NOT NULL DEFAULT '{}',
    avg_review_time_minutes INT DEFAULT 30,
    accept_rate         FLOAT DEFAULT 0.85,
    availability        TEXT NOT NULL DEFAULT 'available' CHECK (
        availability IN ('available','busy','out_of_office')
    ),
    workload_count      INT NOT NULL DEFAULT 0,
    expertise_embedding VECTOR(768),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_reviewer_org ON reviewer_profiles(org_id, availability);

CREATE TABLE IF NOT EXISTS hitl_performance_metrics (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reviewer_id             UUID NOT NULL REFERENCES users(id),
    org_id                  UUID NOT NULL REFERENCES organizations(id),
    period_start            DATE NOT NULL,
    period_end              DATE NOT NULL,
    reviews_completed       INT NOT NULL DEFAULT 0,
    avg_review_time_minutes FLOAT,
    accept_rate             FLOAT,
    correction_rate         FLOAT,
    agreement_rate          FLOAT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(reviewer_id, period_start)
);

CREATE TABLE IF NOT EXISTS review_divergences (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_id         UUID NOT NULL REFERENCES approval_requests(id),
    org_id              UUID NOT NULL REFERENCES organizations(id),
    reviewer_a_id       UUID NOT NULL REFERENCES users(id),
    reviewer_a_decision TEXT NOT NULL,
    reviewer_b_id       UUID NOT NULL REFERENCES users(id),
    reviewer_b_decision TEXT NOT NULL,
    resolution          TEXT,
    resolved_by         TEXT,
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_divergences_org ON review_divergences(org_id, approval_id);

-- Extend approval_requests
ALTER TABLE approval_requests
    ADD COLUMN IF NOT EXISTS reviewer_type TEXT
        CHECK (reviewer_type IN ('clinical','data_manager','regulatory','biostatistician','any')),
    ADD COLUMN IF NOT EXISTS trigger_category TEXT
        CHECK (trigger_category IN (
            'confidence_below_threshold','hallucination_detected',
            'first_time_pattern','hitl_always','exception'
        )),
    ADD COLUMN IF NOT EXISTS assigned_reviewer_id UUID REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS review_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS sla_deadline TIMESTAMPTZ;

-- Extend users with manager_id for escalation hierarchy
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id);
