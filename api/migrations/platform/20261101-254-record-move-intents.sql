-- A move of records between collections is two commits: the workspace's
-- (the records, their tags and files) and the server's (label codes, field
-- definitions, history). The move is written here before either, and goes in
-- the server's commit; one a crash left is finished by the move recovery
-- pass once its records are in their new collection, and dropped when they
-- never got there (#9071). Additive: a new table.
CREATE TABLE IF NOT EXISTS record_move_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  module_name text NOT NULL,
  ids text[] NOT NULL,
  from_instance text NOT NULL,
  to_instance text NOT NULL,
  carry_fields text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS record_move_intents_org_idx ON record_move_intents (org_id, created_at);
