
-- Staff Hierarchy & Lead Management Upgrade - Phase 2
BEGIN;

-- 1. Enhance staff_members with capacity and performance tracking
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS max_capacity INTEGER DEFAULT 20;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS avg_response_time_seconds INTEGER DEFAULT 0;

-- 2. Enhance candidates with response tracking and nurture status
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS last_staff_response_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS nurture_status VARCHAR(50) DEFAULT 'none'; -- 'none', 'pending_followup', 'escalated'
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS review_status VARCHAR(50) DEFAULT 'none'; -- 'none', 'pending', 'approved', 'rejected'

-- 3. Create lead_reviews table for formal closing process
CREATE TABLE IF NOT EXISTS lead_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_members(id) ON DELETE CASCADE,
    manager_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    closing_date DATE NOT NULL,
    notes TEXT,
    screenshot_url TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    manager_feedback TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create performance_metrics table for historical analytics
CREATE TABLE IF NOT EXISTS performance_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID REFERENCES staff_members(id) ON DELETE CASCADE,
    metric_date DATE DEFAULT CURRENT_DATE,
    leads_handled INTEGER DEFAULT 0,
    leads_closed INTEGER DEFAULT 0,
    avg_response_time INTEGER DEFAULT 0,
    UNIQUE(staff_id, metric_date)
);

-- Indexing for Action Center and Analytics
CREATE INDEX IF NOT EXISTS idx_candidates_assigned_status ON candidates(assigned_to, lead_status);
CREATE INDEX IF NOT EXISTS idx_candidates_nurture ON candidates(nurture_status);
CREATE INDEX IF NOT EXISTS idx_lead_reviews_status ON lead_reviews(status);
CREATE INDEX IF NOT EXISTS idx_lead_reviews_manager ON lead_reviews(manager_id);

COMMIT;
