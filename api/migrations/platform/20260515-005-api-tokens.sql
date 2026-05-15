-- Long-lived API tokens for CLI / AI / agent use.
--
-- Distinct from session JWTs (those expire in 90d and live in browser
-- localStorage). API tokens are user-minted, optionally non-expiring,
-- shown to the user exactly once on create.
--
-- Format on the wire: `cbt_<48 chars of base64url>`. We store only
-- the SHA-256 hash; lookup by hash on auth. token_prefix (first 12
-- chars) is kept plaintext so the UI can show `cbt_abc123…` to
-- distinguish multiple tokens.

create table api_tokens (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  name           text not null,
  -- SHA-256 of the full token string. Unique so we can look up by it.
  token_hash     text not null unique,
  -- First N chars of the plaintext token, kept for UI display
  -- ("cbt_abc123…"). Never enough to authenticate with.
  token_prefix   text not null,
  expires_at     timestamptz,
  last_used_at   timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now()
);

create index api_tokens_user_idx on api_tokens(user_id);
create index api_tokens_active_idx
  on api_tokens(user_id)
  where revoked_at is null;
