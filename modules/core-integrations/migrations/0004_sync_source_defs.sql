-- Installed declarative sync-source manifests (per workspace). A connection's
-- connector_id resolves to a global built-in connector OR one of these manifests,
-- so a workspace can sync from any HTTP source without a platform deploy.

create table core_integrations_sync_source_defs (
  id          uuid primary key default gen_random_uuid(),
  source_id   text not null,            -- the manifest id (= a connection's connector_id)
  name        text not null,
  manifest    jsonb not null,           -- the validated SyncSourceManifest
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (source_id)
);

-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_integrations_sync_source_defs;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0004_sync_source_defs';
