-- Production hardening for clinical pathway and chat memory database.
-- Safe to rerun.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_conditions_key
ON clinical.conditions(condition_key);

CREATE INDEX IF NOT EXISTS idx_pathway_nodes_condition_id
ON clinical.pathway_nodes(condition_id);

CREATE INDEX IF NOT EXISTS idx_pathway_nodes_node_key
ON clinical.pathway_nodes(node_key);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_session_id
ON clinical.chat_sessions(session_id);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id_created_at
ON clinical.chat_messages(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_context_state_session_id
ON clinical.clinical_context_state(session_id);

CREATE TABLE IF NOT EXISTS clinical.workflow_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  node_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  input_payload JSONB,
  output_payload JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_session_id
ON clinical.workflow_audit_logs(session_id, created_at DESC);

ALTER TABLE clinical.pathway_nodes
ADD COLUMN IF NOT EXISTS guideline_version TEXT DEFAULT 'v1';

ALTER TABLE clinical.pathway_nodes
ADD COLUMN IF NOT EXISTS guideline_source TEXT DEFAULT 'Clinical Management Guidelines';

ALTER TABLE clinical.pathway_nodes
ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_pathway_nodes_active
ON clinical.pathway_nodes(is_active);

COMMIT;
