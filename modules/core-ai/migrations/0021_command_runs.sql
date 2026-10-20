CREATE TABLE IF NOT EXISTS core_ai_command_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  command_id text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  result jsonb,
  status_code integer NOT NULL DEFAULT 200,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS core_ai_command_runs_undelivered
  ON core_ai_command_runs (user_id, created_at) WHERE delivered_at IS NULL;
