
-- Lead Hierarchy & Reminders Migration
BEGIN;

-- 1. Add manager_id to staff_members for team mapping
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES staff_members(id) ON DELETE SET NULL;
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS is_on_leave BOOLEAN DEFAULT FALSE;

-- 2. Add next_followup_at and metadata to lead_activity_log
ALTER TABLE lead_activity_log ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE lead_activity_log ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- 3. Create audit_logs table for immutable tracking
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    entity_type VARCHAR(50) NOT NULL, -- 'lead', 'staff', 'reminder'
    entity_id UUID NOT NULL,
    action VARCHAR(100) NOT NULL, -- 'reassign', 'takeover', 'status_change', 'snooze'
    previous_state JSONB,
    new_state JSONB,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create reminders table for tracking follow-up status
CREATE TABLE IF NOT EXISTS lead_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_members(id) ON DELETE CASCADE,
    activity_id UUID REFERENCES lead_activity_log(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'shown', 'snoozed', 'done', 'missed'
    snooze_count INTEGER DEFAULT 0,
    last_snoozed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexing for performance
CREATE INDEX IF NOT EXISTS idx_lead_reminders_staff_status ON lead_reminders(staff_id, status);
CREATE INDEX IF NOT EXISTS idx_lead_reminders_scheduled_at ON lead_reminders(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_staff_members_manager_id ON staff_members(manager_id);

COMMIT;
