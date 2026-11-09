-- A write that belongs to a person, not to one workspace (making a new
-- workspace), sent again with its Idempotency-Key, gets the answer the first
-- one got and changes nothing more (#7923). request_replays is keyed by
-- workspace, so a workspace's create had nowhere to keep its answer: a lost
-- answer and Create pressed again made a second workspace. Kept per person
-- and key for a day; a person's own older rows go when they next send one.
-- Additive.
CREATE TABLE IF NOT EXISTS account_request_replays (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  fingerprint text NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'unreplayable')),
  status integer,
  content_type text,
  body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
