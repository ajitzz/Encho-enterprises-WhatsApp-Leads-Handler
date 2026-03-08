
-- ⚠️ WARNING: THIS WILL RESET YOUR DATABASE ⚠️

BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DROP TABLE IF EXISTS scheduled_messages CASCADE;
DROP TABLE IF EXISTS candidate_messages CASCADE;
DROP TABLE IF EXISTS driver_documents CASCADE;
DROP TABLE IF EXISTS lead_activity_logs CASCADE;
DROP TABLE IF EXISTS lead_assignment_history CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS bot_versions CASCADE;
DROP TABLE IF EXISTS candidates CASCADE;
DROP TABLE IF EXISTS system_settings CASCADE;

-- 1. System Config
CREATE TABLE system_settings (
    key VARCHAR(50) PRIMARY KEY,
    value JSONB
);

-- 2. Candidates
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
    owner_manager_email VARCHAR(255),
    owner_staff_email VARCHAR(255),
    assignment_status VARCHAR(50) DEFAULT 'unassigned',
    next_followup_at BIGINT,
    last_outcome VARCHAR(100),
    last_action_at BIGINT,
    row_version INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE users (
    email VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'staff',
    manager_email VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE lead_assignment_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    manager_email VARCHAR(255),
    staff_email VARCHAR(255),
    assigned_by_email VARCHAR(255),
    assigned_by_role VARCHAR(50),
    note TEXT,
    active BOOLEAN DEFAULT TRUE,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    unassigned_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE lead_activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    actor_email VARCHAR(255),
    actor_role VARCHAR(50),
    action VARCHAR(100),
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Messages
CREATE TABLE candidate_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
    text TEXT,
    type VARCHAR(50) DEFAULT 'text',
    status VARCHAR(50) DEFAULT 'sent',
    whatsapp_message_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Scheduled
CREATE TABLE scheduled_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    scheduled_time BIGINT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    error_log TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Bot
CREATE TABLE bot_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(20) DEFAULT 'draft',
    settings JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Documents
CREATE TABLE driver_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    type VARCHAR(50),
    url TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMIT;
