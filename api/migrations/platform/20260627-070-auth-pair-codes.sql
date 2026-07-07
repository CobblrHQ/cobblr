-- QR pair-login codes. A logged-in DESKTOP (no camera) mints a short-lived,
-- single-use code via POST /auth/pair/start and renders it as a QR carrying
-- /pair?code=<code>. A PHONE scans, POSTs /auth/pair/claim, and is signed in
-- as the SAME user, landed in the SAME workspace (org_slug) — so the phone's
-- camera scans flow into that workspace's scan inbox the desktop already shows.
--
-- Same security posture as the magic-link / reset / verify tables: the code is
-- stored HASHED (sha256) — plaintext only ever transits the start response →
-- QR → claim. Single-use via claimed_at; time-bounded via expires_at (~90s).
-- Multi-tenant addition over the original: org_slug pins the
-- workspace the phone lands in, and membership of it is verified at BOTH start
-- (the minter) and claim (defends against a membership revoked in between).

create table auth_pair_codes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  org_slug     text not null,
  code_hash    text not null unique,
  expires_at   timestamptz not null default (now() + interval '90 seconds'),
  claimed_at   timestamptz,
  created_at   timestamptz not null default now(),
  request_ip   text,
  request_ua   text
);
-- Hot path: claim looks up by hash, gated on still-unclaimed.
create index auth_pair_codes_active_idx
  on auth_pair_codes(code_hash)
  where claimed_at is null;
-- Housekeeping / reaper by age (rows are tiny + harmless once expired).
create index auth_pair_codes_expires_idx on auth_pair_codes(expires_at);

-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS auth_pair_codes;
--   DELETE FROM migrations WHERE name = 'platform::20260627-070-auth-pair-codes.sql';
