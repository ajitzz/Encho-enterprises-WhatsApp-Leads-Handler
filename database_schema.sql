
-- ⚠️ WARNING: THIS WILL RESET YOUR DATABASE ⚠️

BEGIN;

-- 1. Enable Extensions for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Clean up existing tables
DROP TABLE IF EXISTS scheduled_messages CASCADE;
DROP TABLE IF EXISTS candidate_messages CASCADE;
DROP TABLE IF EXISTS driver_documents CASCADE;
DROP TABLE IF EXISTS bot_versions CASCADE;
DROP TABLE IF EXISTS candidates CASCADE;

-- 3. Candidates (Drivers/Leads)
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Message History
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

-- 5. Scheduled Messages (Fixed for 500 Error)
CREATE TABLE scheduled_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    scheduled_time BIGINT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    error_log TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Bot Configurations
CREATE TABLE bot_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status VARCHAR(20) DEFAULT 'draft',
    settings JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Documents
CREATE TABLE driver_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    type VARCHAR(50),
    url TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_candidates_phone ON candidates(phone_number);
CREATE INDEX idx_scheduled_lookup ON scheduled_messages(status, scheduled_time);

COMMIT;
