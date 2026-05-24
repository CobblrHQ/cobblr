-- core-labels-qr: cross-tenant token lookup table.
--
-- Each printed label gets its own scan token. Token-per-print means
-- revoking one printed copy doesn't kill all copies. Lives in
-- cobblr_meta so the unauthenticated /qr/:token route resolves in
-- one query — same pattern as public_surface_tokens.
--
-- See docs/design-decisions/core-labels-qr.md.

create table core_labels_qr_tokens (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique,
  org_id        uuid not null references orgs(id) on delete cascade,
  entity_kind   text not null,
  entity_id     uuid not null,
  -- mode='navigate' (default) → scan → entity detail page
  -- mode='action'   → scan → confirmation card → invoke action
  mode          text not null default 'navigate' check (mode in ('navigate', 'action')),
  -- Only set when mode='action'. The platform action id to invoke
  -- once the user confirms on the scan-landing card.
  action_id     text,
  -- auth='public' → scan resolves without authentication (read-only)
  -- auth='session' → requires the scanner be logged in to org_id
  auth          text not null default 'session' check (auth in ('public', 'session')),
  -- Free-form bag of token-level config (label text, expiry hint, etc).
  config        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  expires_at    timestamptz
);

create index core_labels_qr_tokens_org_idx
  on core_labels_qr_tokens(org_id, entity_kind, entity_id)
  where revoked_at is null;
