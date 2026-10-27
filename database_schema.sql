
-- ⚠️ WARNING: THIS WILL RESET YOUR DATABASE ⚠️

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS lead_reminders CASCADE;
DROP TABLE IF EXISTS lead_activity_log CASCADE;
DROP TABLE IF EXISTS scheduled_messages CASCADE;
DROP TABLE IF EXISTS candidate_messages CASCADE;
DROP TABLE IF EXISTS driver_documents CASCADE;
DROP TABLE IF EXISTS bot_versions CASCADE;
DROP TABLE IF EXISTS candidates CASCADE;
DROP TABLE IF EXISTS staff_members CASCADE;
DROP TABLE IF EXISTS system_settings CASCADE;

-- 1. System Config
CREATE TABLE system_settings (
    key VARCHAR(50) PRIMARY KEY,
    value JSONB
);

-- 2. Staff
CREATE TABLE staff_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'staff',
    manager_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    is_active_for_auto_dist BOOLEAN DEFAULT FALSE,
    last_assigned_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Candidates
CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255),
    stage VARCHAR(50) DEFAULT 'New',
    last_message TEXT,
    last_message_at BIGINT,
    source VARCHAR(50) DEFAULT 'Organic',
    is_human_mode BOOLEAN DEFAULT FALSE,
    current_bot_step_id VARCHAR(100),
    variables JSONB DEFAULT '{}'::jsonb,
    assigned_to UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    assigned_manager_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    follow_up_date TIMESTAMP WITH TIME ZONE,
    follow_up_note TEXT,
    is_pushed_to_closing BOOLEAN DEFAULT FALSE,
    closing_notes TEXT,
    closing_screenshot_url TEXT,
    lead_status VARCHAR(50) DEFAULT 'new',
    last_action_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Activity Log
CREATE TABLE lead_activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    notes TEXT,
    media_url TEXT,
    next_followup_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Messages
CREATE TABLE candidate_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
    text TEXT,
    type VARCHAR(50) DEFAULT 'text',
    status VARCHAR(50) DEFAULT 'sent',
    whatsapp_message_id VARCHAR(255),
    sender_type VARCHAR(50),
    is_internal BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Scheduled
CREATE TABLE scheduled_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    scheduled_time BIGINT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    error_log TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Bot
CREATE TABLE bot_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(20) DEFAULT 'draft',
    settings JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Documents
CREATE TABLE driver_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    type VARCHAR(50),
    url TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. Audit Logs
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES staff_members(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID,
    previous_state JSONB,
    new_state JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 10. Reminders
CREATE TABLE lead_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    staff_id UUID REFERENCES staff_members(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 11. Canned Responses & Macros
CREATE TABLE canned_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shortcut VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(100) NOT NULL,
    body TEXT NOT NULL,
    category VARCHAR(50) DEFAULT 'general',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_candidates_assigned_to ON candidates(assigned_to);
CREATE INDEX IF NOT EXISTS idx_candidates_unassigned_pool ON candidates(last_message_at DESC NULLS LAST, created_at DESC) WHERE assigned_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_candidates_last_message_at ON candidates(last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_candidates_lead_status ON candidates(lead_status);
CREATE INDEX IF NOT EXISTS idx_candidate_messages_whatsapp_message_id ON candidate_messages(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidate_messages_candidate_created_at ON candidate_messages(candidate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending_scheduled_time ON scheduled_messages(scheduled_time ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_candidate_pending_time ON scheduled_messages(candidate_id, scheduled_time ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_lead_reminders_staff_status ON lead_reminders(staff_id, status);
CREATE INDEX IF NOT EXISTS idx_lead_reminders_scheduled_at ON lead_reminders(scheduled_at);

COMMIT;
