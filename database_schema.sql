
-- ⚠️ WARNING: THIS SCRIPT DROPS ALL EXISTING DATA ⚠️
-- Run this in the Neon Console SQL Editor to fix the "column does not exist" errors.

DROP TABLE IF EXISTS scheduled_messages CASCADE;
DROP TABLE IF EXISTS candidate_messages CASCADE;
DROP TABLE IF EXISTS bot_versions CASCADE;
DROP TABLE IF EXISTS candidates CASCADE;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Candidates (Leads/Drivers) Table
CREATE TABLE candidates (
    id UUID PRIMARY KEY,
    phone_number VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255),
    stage VARCHAR(50) DEFAULT 'New',
    last_message_at BIGINT,
    last_message TEXT,
    variables JSONB DEFAULT '{}',
    tags TEXT[],
    notes TEXT,
    current_node_id VARCHAR(255),
    is_human_mode BOOLEAN DEFAULT FALSE,
    human_mode_ends_at BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Messages Table
CREATE TABLE candidate_messages (
    id UUID PRIMARY KEY,
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
    text TEXT,
    type VARCHAR(50),
    status VARCHAR(50),
    whatsapp_message_id VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Bot Versions Table (For storing flows)
CREATE TABLE bot_versions (
    id UUID PRIMARY KEY,
    phone_number_id VARCHAR(50),
    version_number INT,
    status VARCHAR(20) CHECK (status IN ('draft', 'published', 'archived')),
    settings JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Scheduled Messages Table (Fixed Schema)
CREATE TABLE scheduled_messages (
    id UUID PRIMARY KEY,
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    payload JSONB,
    scheduled_time BIGINT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_candidates_phone ON candidates(phone_number);
CREATE INDEX idx_candidates_last_msg ON candidates(last_message_at DESC);
CREATE INDEX idx_messages_candidate ON candidate_messages(candidate_id);
CREATE INDEX idx_messages_created ON candidate_messages(created_at DESC);
CREATE INDEX idx_scheduled_time ON scheduled_messages(scheduled_time) WHERE status = 'pending';
