-- Per-account brute-force lockout state (audit M-BRUTE).
--
-- The login IP limiter in routes/auth.ts is an in-process Map keyed by client
-- IP. That is per-INSTANCE (canary + main each keep their own counter, so the
-- effective ceiling is 30 x N/min across instances) and IP-ONLY (no per-account
-- counter, so distributed / rotating-IP credential stuffing against many
-- accounts is never throttled per account). This table is the shared,
-- cross-instance per-account counter: one row per submitted login email, its
-- consecutive-failure count, and the instant it unlocks.
--
-- PLATFORM migration: runs ONCE on cobblr_meta, not per tenant. No tenant
-- self-heal is needed — the moment this migration lands, every workspace's
-- logins read/write this one shared table.
--
-- Bucketed by the SUBMITTED email, existing account or not, so the lockout
-- behaves identically whether or not the email is registered: it never becomes
-- an account-enumeration oracle. Email is stored already lowercased + trimmed,
-- matching how POST /login normalizes it before lookup.
--
-- manual recovery if this fails partway:
--   drop table if exists login_attempts;
--   delete from migrations where name = '20260825-112-login-attempts.sql';

create table login_attempts (
  -- The submitted login email, lowercased + trimmed (as routes/auth.ts does).
  email          text        primary key,
  -- Consecutive failures since the last success. Reset to 0 (row deleted) on a
  -- correct password.
  failed_count   integer     not null default 0,
  -- When set and in the future, login is refused before the password check.
  locked_until   timestamptz,
  -- Diagnostics + the reaper's age check.
  last_failed_at timestamptz,
  updated_at     timestamptz not null default now()
);

comment on table login_attempts is
  'Per-account brute-force lockout state, shared across api instances. One row per submitted login email (lowercased+trimmed). Audit M-BRUTE.';
