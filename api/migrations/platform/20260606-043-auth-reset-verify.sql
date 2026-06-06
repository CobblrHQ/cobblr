-- Password-reset + email-verification: hashed single-use token tables + a
-- verification marker on users. Both flows deliver through the auth-email seam
-- (a self-hoster's BYO sender or the cloud overlay's managed one); with no
-- sender they fall back to the dev link (non-prod only).

-- 1) Email-verification marker. Nullable: NULL = unverified. Backfill EXISTING
--    users as verified (they predate verification — grandfather them, don't
--    nag). New signups start NULL and receive a verification email.
alter table users add column email_verified_at timestamptz;
update users set email_verified_at = created_at where email_verified_at is null;

-- 2) Password-reset tokens. Hashed (sha256), single-use, 1-hour default.
create table auth_password_reset_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  expires_at   timestamptz not null default (now() + interval '1 hour'),
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  request_ip   text,
  request_ua   text
);
create index auth_password_reset_tokens_user_idx
  on auth_password_reset_tokens(user_id, created_at desc);
-- Hot path: lookup by hash, gated on unconsumed.
create index auth_password_reset_tokens_active_idx
  on auth_password_reset_tokens(token_hash)
  where consumed_at is null;

-- 3) Email-verification tokens. Hashed, single-use, 24-hour default. Carries
--    the email the token was issued for, so a stale token can't verify a
--    changed address.
create table auth_email_verify_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  email        text not null,
  token_hash   text not null unique,
  expires_at   timestamptz not null default (now() + interval '24 hours'),
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  request_ip   text,
  request_ua   text
);
create index auth_email_verify_tokens_user_idx
  on auth_email_verify_tokens(user_id, created_at desc);
create index auth_email_verify_tokens_active_idx
  on auth_email_verify_tokens(token_hash)
  where consumed_at is null;
