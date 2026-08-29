-- The no-account "try it for an hour" sandbox (docs/design-decisions/try-sandbox.md).
--
-- Two additive changes, both nullable/defaulted, so an older api reading this
-- schema is unaffected (§14.3): it simply never sets them.
--
-- `orgs.sandbox` marks a workspace handed out by GET /try. The reaper needs it
-- to tell a one-hour sandbox (delete on expiry, no warning, because the visitor
-- was told the lifetime on the way in) from an account trial (warn, grace, then
-- delete). Both carry `trial_expires_at`; only the sandbox is disposable.
alter table orgs add column if not exists sandbox boolean not null default false;

-- Live-sandbox counting is a hot path (every GET /try consults the global cap),
-- and expiry sweeps run every few minutes. Partial: sandboxes are a tiny
-- minority of rows and the only ones ever scanned this way.
create index if not exists orgs_sandbox_live_idx
  on orgs (trial_expires_at)
  where sandbox;

-- The link IS the credential, so it is stored hashed, exactly like
-- auth_magic_tokens. Unlike a magic link it is NOT consumed on use: it is the
-- only way back into a workspace that has no account, so it stays valid for the
-- sandbox's whole life (a refresh, a new tab, forwarding it to your phone).
create table if not exists try_sandbox_tokens (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references orgs(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  -- Set when the visitor binds an email ("keep it"): the sandbox becomes an
  -- ordinary account trial and this link stops working.
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  -- Crude abuse signal, same as auth_magic_tokens. Nullable for tests.
  request_ip   text,
  request_ua   text
);

create index if not exists try_sandbox_tokens_active_idx
  on try_sandbox_tokens (token_hash)
  where revoked_at is null;
