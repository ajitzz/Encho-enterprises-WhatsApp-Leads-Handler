
-- ⚠️ WARNING: THIS SCRIPT DROPS ALL EXISTING DATA ⚠️
-- Run this in the Neon Console SQL Editor to fix "relation does not exist" or "column missing" errors.

BEGIN;

-- 1. Drop existing tables to ensure a clean slate
DROP TABLE IF EXISTS driver_documents CASCADE;
DROP TABLE IF EXISTS scheduled_messages CASCADE;
DROP TABLE IF EXISTS candidate_messages CASCADE;
DROP TABLE IF EXISTS bot_versions CASCADE;
DROP TABLE IF EXISTS candidates CASCADE;

-- 2. Enable UUID extension for unique IDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 3. Create Candidates (Drivers) Table
CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255),
    stage VARCHAR(50) DEFAULT 'New',
    last_message_at BIGINT,
    last_message TEXT,
    notes TEXT,
    source VARCHAR(50) DEFAULT 'Organic',
    current_node_id VARCHAR(255),
    is_human_mode BOOLEAN DEFAULT FALSE,
    human_mode_ends_at BIGINT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create Messages Table
CREATE TABLE candidate_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    direction VARCHAR(10) CHECK (direction IN ('in', 'out')),
    text TEXT,
    type VARCHAR(50),
    status VARCHAR(50),
    whatsapp_message_id VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Create Scheduled Messages Table (Fixes 500 Errors)
CREATE TABLE scheduled_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    payload JSONB,
    scheduled_time BIGINT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Create Bot Versions Table
CREATE TABLE bot_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number_id VARCHAR(50),
    version_number INT,
    status VARCHAR(20) CHECK (status IN ('draft', 'published', 'archived')),
    settings JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Create Documents Table (Fixes 404 Errors)
CREATE TABLE driver_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    type VARCHAR(50),
    url TEXT,
    status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Create Indexes for Performance
CREATE INDEX idx_candidates_phone ON candidates(phone_number);
CREATE INDEX idx_candidates_last_msg ON candidates(last_message_at DESC);
CREATE INDEX idx_scheduled_status ON scheduled_messages(status, scheduled_time);

COMMIT;
