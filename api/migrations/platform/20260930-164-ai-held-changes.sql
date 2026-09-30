-- A delete an assistant asked for over MCP, waiting for its person's yes.
-- Every AI door (the MCP server's token, the hosted endpoint with any token,
-- a connector signed in with OAuth) holds a DELETE here instead of running it,
-- and the person answers on a card: Delete it (replayed under their own
-- session) or Keep it. A card pressed a day later starts nothing. Keyed by
-- workspace in meta, so every workspace has it from the moment this runs.
-- Additive.
CREATE TABLE IF NOT EXISTS ai_held_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method text NOT NULL,
  path text NOT NULL,
  summary text NOT NULL,
  door text NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'done', 'kept', 'expired', 'failed')),
  outcome text,
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_held_changes_by_person ON ai_held_changes (user_id, status, created_at DESC);
