-- What a scan row looked like before something rewrote it (#6100).
--
-- A re-run, a replay, a corrected barcode, a heal: each can replace the name,
-- the brand, the pictures and the kind a row had. Every such rewrite writes
-- the row's fields as they stood here first, and its History entry carries
-- this id, so Undo on the toast and Put back on History restore exactly what
-- was there. Only the newest few per row are kept (services/scan-history.ts).
create table if not exists core_scan_item_revisions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references core_scan_inbox_items(id) on delete cascade,
  action text not null,
  before jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists core_scan_item_revisions_item_idx
  on core_scan_item_revisions (item_id, created_at desc);
