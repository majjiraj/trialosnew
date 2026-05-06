ALTER TABLE approval_requests
ADD COLUMN IF NOT EXISTS reviewer_role TEXT NOT NULL DEFAULT 'sponsor';

ALTER TABLE approval_requests
ADD COLUMN IF NOT EXISTS parent_approval_id UUID REFERENCES approval_requests(id);
