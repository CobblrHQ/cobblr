-- The undo steps a run handed back to the person who ran it. An undo is its
-- requester's to run whatever their role (#5193): a member taps Use one, holds
-- the default capability for it, and is handed inventory:restore-part as the
-- way back, which they hold no grant for. The step is kept here as issued, so
-- the same person running exactly that step is admitted as its requester, once.
-- Arguments a person builds themselves are not in here and still need the grant.
-- Additive; a sweep removes used and stale rows.
CREATE TABLE IF NOT EXISTS issued_undos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_id text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  entity_kind text,
  entity_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS issued_undos_by_person ON issued_undos (org_id, user_id, action_id) WHERE used_at IS NULL;
