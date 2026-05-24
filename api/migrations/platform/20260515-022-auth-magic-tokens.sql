-- core-auth-extensions v0.1: magic-link tokens for passwordless auth.
--
-- A one-time, time-bounded token tied to an email. Issued by
-- POST /auth/magic/request; consumed by POST /auth/magic/consume.
-- Single use: consumed_at is set on first redeem and re-redeems 410.
--
-- Tokens are stored HASHED. Plaintext is only ever returned ONCE
-- from /request (in dev mode where no SMTP is configured; in
-- production an email channel would deliver it).

create table auth_magic_tokens (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  token_hash   text not null unique,
  -- Default 15-minute lifetime. POST /request sets explicitly to
  -- now() + 15min so this default is just a safety net for
  -- direct INSERTs.
  expires_at   timestamptz not null default (now() + interval '15 minutes'),
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  -- IP / UA captured at request time for crude abuse signal. Both
  -- nullable for tests that bypass the route layer.
  request_ip   text,
  request_ua   text
);

create index auth_magic_tokens_email_idx
  on auth_magic_tokens(email, created_at desc);
-- Hot path: lookup by hash, gated on unexpired + unconsumed.
create index auth_magic_tokens_active_idx
  on auth_magic_tokens(token_hash)
  where consumed_at is null;
