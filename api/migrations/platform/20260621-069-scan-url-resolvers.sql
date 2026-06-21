-- scan_url_resolvers — the operator-managed list of vendor scan-URL resolvers.
--
-- A scanned QR is often a maker URL encoding a specific product (Polar Filament
-- spool → 3dqr.co/?i=<id>). Rather than a code module per vendor, the platform
-- keeps a LIST of declarative manifests and one generic interpreter consults it.
-- Built-in vendors (Polar) ship in code; THIS table holds operator-added ones (and
-- can override a built-in by reusing its id). Global — vendor resolvers fetch
-- public maker data, the same for every workspace; not org-scoped.
-- See api/src/platform/scan-url-resolvers/.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS scan_url_resolvers;
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260621-069-scan-url-resolvers';

create table scan_url_resolvers (
  id           uuid primary key default gen_random_uuid(),
  -- the manifest's stable id (provenance + de-dup; matches a built-in id to override it)
  resolver_id  text not null unique,
  label        text not null,
  enabled      boolean not null default true,
  position     integer not null default 0,
  -- the full ScanUrlResolverManifest (match / request / response / output / cache_ns)
  manifest     jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
