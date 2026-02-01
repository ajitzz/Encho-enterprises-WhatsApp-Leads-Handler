
-- ⚠️ WARNING: THIS WILL RESET YOUR DATABASE ⚠️

BEGIN;

-- 1. Clean up existing tables
DROP TABLE IF EXISTS scheduled_messages CASCADE;
DROP TABLE IF EXISTS candidate_messages CASCADE;
DROP TABLE IF EXISTS driver_documents CASCADE;
DROP TABLE IF EXISTS bot_versions CASCADE;
DROP TABLE IF EXISTS candidates CASCADE;

-- 2. Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 3. Candidates (Drivers/Leads)
CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255),
    stage VARCHAR(50) DEFAULT 'New', -- New, Qualified, Rejected, etc.
    last_message TEXT,
    last_message_at BIGINT,
    source VARCHAR(50) DEFAULT 'Organic',
    notes TEXT,
    is_human_mode BOOLEAN DEFAULT FALSE,
    variables JSONB DEFAULT '{}'::jsonb, -- Store dynamic bot data here
    tags TEXT[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Message History
CREATE TABLE candidate_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
    text TEXT, -- Stores text OR JSON string for complex media messages
    type VARCHAR(50) DEFAULT 'text', -- text, image, video, document, template
    status VARCHAR(50) DEFAULT 'sent', -- sent, delivered, read, failed
    whatsapp_message_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Scheduled Messages (The Core Fix)
CREATE TABLE scheduled_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    payload JSONB NOT NULL, -- Stores { text, mediaUrl, mediaType } as RAW JSON
    scheduled_time BIGINT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending', -- pending, processing, sent, failed
    error_log TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Bot Configurations
CREATE TABLE bot_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number_id VARCHAR(50),
    version_number INT,
    status VARCHAR(20) DEFAULT 'draft',
    settings JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Documents (KYC)
CREATE TABLE driver_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    type VARCHAR(50),
    url TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Performance Indexes
CREATE INDEX idx_candidates_phone ON candidates(phone_number);
CREATE INDEX idx_candidates_last_msg ON candidates(last_message_at DESC);
CREATE INDEX idx_scheduled_lookup ON scheduled_messages(status, scheduled_time);

COMMIT;
