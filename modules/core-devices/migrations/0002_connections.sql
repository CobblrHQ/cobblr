-- core-devices owns device CONNECTIONS (the substrate), moved out of digifab.
-- Two-phase + additive (CLAUDE.md §15.6): create the canonical table here and
-- BACKFILL from digifab_connections if it exists. digifab_connections is KEPT
-- (not dropped) as a safety copy — digifab now reads/writes connections through
-- the platform().devices seam, which is backed by THIS table. A later PR drops
-- the old table once this has run cleanly on prod.

create table core_devices_connections (
  id                uuid primary key default gen_random_uuid(),
  type              text not null,                       -- "fdm_monster" | "mock" | "edge_adapter" | …
  label             text not null,
  base_url          text not null,
  credentials_enc   text not null default '',            -- AES-GCM ciphertext of { apiKey, … }
  config            jsonb not null default '{}'::jsonb,
  enabled           boolean not null default true,
  capabilities      jsonb not null default '{}'::jsonb,  -- cached probe, e.g. { "routing": true }
  last_sync_at      timestamptz,
  last_sync_status  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One-time backfill, guarded so it's a no-op in a workspace that never enabled
-- digifab (the table won't exist there). Preserves ids so existing references
-- (jobs.connection_id, links.connection_id) stay valid.
do $$
begin
  if exists (select from information_schema.tables where table_name = 'digifab_connections') then
    insert into core_devices_connections
      (id, type, label, base_url, credentials_enc, config, enabled, capabilities, last_sync_at, last_sync_status, created_at, updated_at)
    select id, type, label, base_url, credentials_enc, config, enabled, capabilities, last_sync_at, last_sync_status, created_at, updated_at
      from digifab_connections
    on conflict (id) do nothing;
  end if;
end $$;

-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_devices_connections;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0002_connections';
