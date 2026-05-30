-- digifab — print-farm connections (FDM Monster +).
--
-- A connection is a server-to-server link to a print farm's REST API.
-- API credentials are AES-GCM encrypted with the per-org key in
-- cobblr_meta (same path as core-integrations connectors) and never
-- returned to clients.

create extension if not exists "pgcrypto";

create table digifab_connections (
  id                uuid primary key default gen_random_uuid(),
  type              text not null,                       -- "fdm_monster" | "mock" | …
  label             text not null,
  base_url          text not null,
  credentials_enc   text not null default '',            -- AES-GCM ciphertext of { apiKey }
  config            jsonb not null default '{}'::jsonb,
  enabled           boolean not null default true,
  capabilities      jsonb not null default '{}'::jsonb,  -- cached probe, e.g. { "routing": true }
  last_sync_at      timestamptz,
  last_sync_status  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index digifab_connections_type_idx on digifab_connections(type);
