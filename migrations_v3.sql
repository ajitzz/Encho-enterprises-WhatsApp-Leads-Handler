-- God Eye Architecture Migration

BEGIN;

-- 1. Add lifecycle timestamps to candidates for Velocity tracking
ALTER TABLE candidates 
ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP WITH TIME ZONE;

-- 2. Add presence tracking to staff_members
ALTER TABLE staff_members
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS current_status VARCHAR(20) DEFAULT 'offline';

-- 3. Create daily performance metrics table for historical snapshots
CREATE TABLE IF NOT EXISTS daily_performance_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID REFERENCES staff_members(id) ON DELETE CASCADE,
    record_date DATE NOT NULL DEFAULT CURRENT_DATE,
    
    -- Volume
    leads_claimed INT DEFAULT 0,
    notes_added INT DEFAULT 0,
    reviews_submitted INT DEFAULT 0,
    
    -- Results
    leads_closed INT DEFAULT 0,
    leads_rejected INT DEFAULT 0,
    
    -- Velocity (Stored in minutes, we will average them in the UI)
    total_time_to_review_mins INT DEFAULT 0, 
    total_manager_approval_time_mins INT DEFAULT 0,
    
    -- Presence
    total_online_minutes INT DEFAULT 0,

    UNIQUE(staff_id, record_date)
);

COMMIT;
