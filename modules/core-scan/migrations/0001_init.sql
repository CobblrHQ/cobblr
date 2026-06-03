-- core-scan — barcode + photo identification, generalized.
--
-- Two tables:
--   core_scan_inbox_items: the entity-agnostic staging queue. A
--     scan lands here as `pending`, gets enriched (suggested_name,
--     suggested_manufacturer, catalog image), and waits for the
--     user to confirm into a target entity kind. target_module +
--     target_kind are picked at confirm time so the same module
--     can drop scans into inventory:part / assets:asset /
--     machines:machine without per-kind code.
--
--   core_scan_barcode_cache: per-UPC cache. Workspace-scoped (the
--     same UPC may belong to a different brand at different
--     workspaces — think generic "100ml bottle" UPCs). Both hits
--     and definitive misses cached; rate-limit failures are not.
--
-- See docs/modules/core-scan.md for the v0.1 scope vs v0.2
-- deferrals (web-search fallback, photo-only AI path, receipts,
-- bulk-confirm at scale).

create extension if not exists "pgcrypto";

create table core_scan_inbox_items (
  id                     uuid primary key default gen_random_uuid(),
  status                 text not null default 'pending'
                         check (status in ('pending','enriching','resolved','discarded')),
  source_kind            text not null
                         check (source_kind in ('barcode','photo','url','receipt')),
  barcode_text           text,
  source_url             text,
  image_file_id          uuid,                 -- core_files_files.id; user-supplied photo
  catalog_image_file_id  uuid,                 -- core_files_files.id; resolved catalog photo
  catalog_image_url      text,                 -- transient: catalog photo url before download
  suggested_name         text,
  suggested_manufacturer text,
  suggested_sku          text,
  suggested_metadata     jsonb not null default '{}'::jsonb,
  ai_notes               text,
  ai_confidence          numeric(3,2),
  ai_suggested_at        timestamptz,
  target_module          text,
  target_kind            text,
  target_entity_id       uuid,
  target_location_id     uuid,
  scan_batch_id          uuid,
  scan_area              text,
  quantity               integer not null default 1,
  created_by_user_id     uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  resolved_at            timestamptz
);

create index core_scan_inbox_status_idx
  on core_scan_inbox_items (status, created_at desc);
create index core_scan_inbox_barcode_pending_idx
  on core_scan_inbox_items (barcode_text)
  where status = 'pending' and barcode_text is not null;
create index core_scan_inbox_batch_idx
  on core_scan_inbox_items (scan_batch_id);

create table core_scan_batches (
  id                 uuid primary key default gen_random_uuid(),
  created_by_user_id uuid,
  created_at         timestamptz not null default now()
);

create table core_scan_barcode_cache (
  upc         text primary key,
  found       boolean not null,
  source      text not null,
  title       text,
  brand       text,
  model       text,
  description text,
  category    text,
  image_url   text,
  raw         jsonb not null default '{}'::jsonb,
  fetched_at  timestamptz not null default now()
);
