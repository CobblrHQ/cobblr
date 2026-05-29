-- H8 — inventory list + search performance at scale (40k+ parts).
--
-- Measured at 40k rows, both hot paths were sequential scans:
--   • the default list (ORDER BY name, id) → seq scan + top-N sort
--   • search (lower(name)/notes/… LIKE '%term%') → full seq scan
--
-- Two fixes:
--   1. A (name, id) btree so the keyset-paginated list is an index
--      scan — no full scan, no sort. (name,id) matches the exact
--      ORDER BY the list resolver uses.
--   2. A single generated `search_blob` (lower, all searchable text
--      concatenated) + ONE trigram GIN. A multi-column OR of
--      LIKE '%term%' can't use per-column indexes (the planner
--      seq-scans for any un-indexed branch); collapsing the searchable
--      fields into one trigram-indexed column makes fuzzy search an
--      index scan. The list resolver's search switches to this column.
--
-- Additive + idempotent. Adding a STORED generated column rewrites the
-- table once (fast at 40k; a one-time cost on larger sets).
--
-- manual recovery if this fails partway:
--   ALTER TABLE inventory_parts DROP COLUMN IF EXISTS search_blob;
--   DROP INDEX IF EXISTS inventory_parts_name_id_idx;
--   DELETE FROM migrations WHERE name = '0005_search_perf.sql';

create extension if not exists pg_trgm;

create index if not exists inventory_parts_name_id_idx
  on inventory_parts (name, id);

alter table inventory_parts
  add column if not exists search_blob text
  generated always as (
    lower(
      coalesce(name, '') || ' ' ||
      coalesce(notes, '') || ' ' ||
      coalesce(serial_number, '') || ' ' ||
      coalesce(model_number, '') || ' ' ||
      coalesce(manufacturer, '')
    )
  ) stored;

create index if not exists inventory_parts_search_trgm_idx
  on inventory_parts using gin (search_blob gin_trgm_ops);
