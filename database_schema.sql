
BEGIN;

-- UUID support
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop all tables (safe reset)
DROP TABLE IF EXISTS driver_documents CASCADE;
DROP TABLE IF EXISTS scheduled_messages CASCADE;
DROP TABLE IF EXISTS candidate_messages CASCADE;
DROP TABLE IF EXISTS bot_versions CASCADE;
DROP TABLE IF EXISTS candidates CASCADE;

-- Candidates (leads)
CREATE TABLE candidates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255),
  stage VARCHAR(50) NOT NULL DEFAULT 'New',
  last_message_at BIGINT,
  last_message TEXT,
  notes TEXT,
  source VARCHAR(50) NOT NULL DEFAULT 'Organic',
  current_node_id VARCHAR(255),
  is_human_mode BOOLEAN NOT NULL DEFAULT FALSE,
  human_mode_ends_at BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Messages (in/out)
CREATE TABLE candidate_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('in','out')),
  text TEXT,
  type VARCHAR(50) NOT NULL DEFAULT 'text',
  status VARCHAR(50) NOT NULL DEFAULT 'sent',
  whatsapp_message_id VARCHAR(255) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_candidate_messages_candidate_created_at
  ON candidate_messages (candidate_id, created_at DESC);

-- Scheduled messages queue
CREATE TABLE scheduled_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_time BIGINT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','sent','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scheduled_messages_due
  ON scheduled_messages (status, scheduled_time);

CREATE INDEX idx_scheduled_messages_candidate
  ON scheduled_messages (candidate_id);

-- Bot versions / settings history
CREATE TABLE bot_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number_id VARCHAR(50),
  version_number INT,
  status VARCHAR(20),
  settings JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_bot_versions_phone_status
  ON bot_versions (phone_number_id, status);

-- Documents
CREATE TABLE driver_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  url TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_driver_documents_candidate_created
  ON driver_documents (candidate_id, created_at DESC);

COMMIT;
