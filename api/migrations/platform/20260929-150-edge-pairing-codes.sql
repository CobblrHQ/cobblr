-- A short, one-time code that installs a bridge without a token ever passing
-- through a terminal: Cobblr shows the code, the installer trades it for the
-- bridge's own token. Only the hash is kept.
CREATE TABLE IF NOT EXISTS edge_pairing_codes (
  code_hash   text PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bridge      text,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS edge_pairing_codes_org ON edge_pairing_codes (org_id);
