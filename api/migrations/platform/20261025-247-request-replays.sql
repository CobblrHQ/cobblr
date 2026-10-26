-- A write sent again with the same Idempotency-Key gets the answer the first
-- one got, and changes nothing more (#7923). A lost response, a double tap or
-- a reconnect sends a create or a stock change twice; the server keeps each
-- write's answer for a day, per person and key, and answers a repeat with it.
-- Keyed by workspace in meta, so every workspace has it from the moment this
-- runs. Additive.
CREATE TABLE IF NOT EXISTS request_replays (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'unreplayable')),
  status integer,
  content_type text,
  body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, key)
);
CREATE INDEX IF NOT EXISTS request_replays_by_age ON request_replays (org_id, created_at);
