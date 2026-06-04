BEGIN;

CREATE SCHEMA IF NOT EXISTS clinical;
SET search_path TO clinical, public;

CREATE TABLE IF NOT EXISTS chat_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clinical_context_state (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  latest_condition_key TEXT REFERENCES conditions(condition_key) ON DELETE SET NULL,
  selected_node_id BIGINT REFERENCES pathway_nodes(id) ON DELETE SET NULL,
  selected_node_key TEXT,
  known_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing_facts TEXT[] NOT NULL DEFAULT '{}',
  last_assistant_output TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
ON chat_messages(session_id);

CREATE INDEX IF NOT EXISTS idx_context_state_session_id
ON clinical_context_state(session_id);

CREATE INDEX IF NOT EXISTS idx_context_state_known_facts
ON clinical_context_state USING gin (known_facts);

COMMIT;
