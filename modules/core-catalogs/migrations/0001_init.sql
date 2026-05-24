-- core-catalogs — reference datasets imported into the workspace
-- that the user's own entities can MATCH against (via core's
-- entity_pairings table with relationship_kind='matches').
--
-- Two tables:
--   catalogs        — one row per imported catalog (name, source,
--                     schema/title/image config, last_sync)
--   catalog_entries — one row per row inside a catalog (opaque
--                     external_id + payload JSONB the source shape)
--
-- Generic over any dataset. Specific data sources (Rebrickable,
-- McMaster, USDA) become pullers registered with the platform
-- contract (v0.3 — not yet built). v0.1 ships CSV upload as the
-- only import path; no module code required for static datasets.

create extension if not exists "pgcrypto";
create extension if not exists pg_trgm;

create table core_catalogs_catalogs (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  source_url    text,
  -- puller_id is the registered puller's name (e.g. "rebrickable")
  -- or null for CSV-imported catalogs that don't have a live source.
  puller_id     text,
  -- schema config the puller / CSV importer writes when creating the
  -- catalog. Keys we care about:
  --   id_column        (CSV header → external_id source)
  --   title_column     (payload key → the entry's displayable title)
  --   image_column     (payload key → the entry's image URL)
  --   subtitle_column  (payload key → the entry's subtitle, optional)
  -- Pullers may add their own keys (rate limits, custom mapping
  -- rules). Opaque to the platform.
  schema        jsonb not null default '{}'::jsonb,
  last_sync_at  timestamptz,
  -- entry_count cached so list views don't have to count(*) every
  -- row. Maintained by the importer on each upsert / delete.
  entry_count   integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index core_catalogs_catalogs_name_idx
  on core_catalogs_catalogs(lower(name));

create table core_catalogs_entries (
  id           uuid primary key default gen_random_uuid(),
  catalog_id   uuid not null references core_catalogs_catalogs(id) on delete cascade,
  -- The source's canonical id. Together with catalog_id, uniquely
  -- identifies a row. Re-imports upsert by this pair so updates from
  -- the source carry through without changing our pairing target.
  external_id  text not null,
  -- Free-form per-source payload. Title / image / subtitle come from
  -- catalog.schema's column hints applied at lookup time.
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index core_catalogs_entries_catalog_external_idx
  on core_catalogs_entries(catalog_id, external_id);

-- Cheap title-prefix + fuzzy search for the match picker. We index
-- the most common default title path (payload->>'name'); pullers
-- whose source uses a different key need to add a second index in a
-- follow-on migration (or v0.3 generalises this).
create index core_catalogs_entries_payload_name_trgm_idx
  on core_catalogs_entries
  using gin ((payload->>'name') gin_trgm_ops);
