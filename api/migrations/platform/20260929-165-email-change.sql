-- Changing the address a person signs in with. Two single-use links per
-- change, both hashed like every other auth token here:
--   confirm  sent to the NEW address; the change happens only when it is used,
--            so nobody can move an account to an address they do not read
--   revert   sent to the OLD address once the change is made, for 7 days, so
--            the person whose account it was can take it back if it was not
--            them (and must then choose a new password)
-- Additive: a new table nothing older reads.
CREATE TABLE IF NOT EXISTS auth_email_change_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('confirm', 'revert')),
  old_email    text NOT NULL,
  new_email    text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_email_change_tokens_user_idx ON auth_email_change_tokens (user_id, created_at DESC);
