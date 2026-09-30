-- A token minted by another token names it (auth/token-lineage.ts): the
-- child can never outlive or out-reach its parent, and revoking the parent
-- revokes it. A one-hour token used to be able to mint a key that never
-- expired, reached every workspace and survived the parent's revocation.
-- Additive; NULL = minted by a person's session (every token before this).
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS parent_token_id uuid REFERENCES api_tokens(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS api_tokens_parent ON api_tokens (parent_token_id) WHERE parent_token_id IS NOT NULL;
