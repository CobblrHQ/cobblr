-- Single-use SIGNUP invites. A platform admin (super-admin) mints a token so
-- one new person can self-register their OWN account + workspace while public
-- signup stays disabled — the invite-only-beta gate. Distinct from
-- `workspace_invites` (which adds an existing/new user to an EXISTING
-- workspace); this one creates a fresh tenant and isn't org-scoped.
--
-- Redeemed through POST /auth/signup with an `invite_token`: the valid token
-- authorises the signup past the PUBLIC_SIGNUP_ENABLED gate, then is consumed.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS signup_invites;
--   DELETE FROM migrations WHERE name = '20260603-040-signup-invites.sql';

create table signup_invites (
  id                uuid primary key default gen_random_uuid(),
  token             text not null unique,
  -- who minted it (a platform admin's user id)
  created_by        uuid not null references users(id),
  -- optional email-lock: when set, only this address may redeem the invite
  invited_email     text,
  -- optional free-text label ("for Bjørn")
  note              text,
  expires_at        timestamptz,
  consumed_at       timestamptz,
  consumed_by_user  uuid references users(id),
  revoked_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index signup_invites_open_idx on signup_invites(consumed_at, revoked_at);
