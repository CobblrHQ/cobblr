-- core-labels-qr — QR code labels + scan-to-action.
--
-- Tenant-side audit log of scans. The token row itself lives in
-- cobblr_meta (cross-tenant) so the unauthenticated `/qr/:token`
-- route can resolve in one query without scanning tenant DBs —
-- same pattern as core-public-surfaces and integrations' inbound
-- tokens.
--
-- See docs/modules/core-labels-qr.md.

create extension if not exists "pgcrypto";

create table core_labels_qr_scans (
  id           uuid primary key default gen_random_uuid(),
  token_id     uuid not null,
  scanned_at   timestamptz not null default now(),
  ua_hint      text,
  referer      text,
  action_invoked text,
  action_ok    boolean
);

create index core_labels_qr_scans_token_idx
  on core_labels_qr_scans(token_id, scanned_at desc);
