-- core-integrations — cross-tenant tables.
--
-- 1. integration_inbound_token_lookup — same shape as
--    public_surface_tokens / core_labels_qr_tokens. Lets the
--    unauthenticated /integrations/<connector>/:token/webhook route
--    resolve in one query without scanning tenant DBs.
--
-- 2. org_encryption_keys — per-workspace AES-GCM master key used to
--    encrypt connector credentials. Generated on first connector
--    install for the workspace; never rotated automatically (v0.2
--    feature). The key is stored base64-encoded.
--
-- See docs/modules/core-integrations.md.

create table integration_inbound_token_lookup (
  token        text primary key,
  org_id       uuid not null references orgs(id) on delete cascade,
  inbound_id   uuid not null,                  -- references tenant's core_integrations_inbound_tokens.id
  connector_id text not null,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);

create index integration_inbound_token_lookup_org_idx
  on integration_inbound_token_lookup(org_id);

create table org_encryption_keys (
  org_id       uuid primary key references orgs(id) on delete cascade,
  -- Base64-encoded 32-byte AES-GCM key. The platform never logs
  -- this; reads it only at credential-decrypt time.
  key_b64      text not null,
  created_at   timestamptz not null default now()
);
