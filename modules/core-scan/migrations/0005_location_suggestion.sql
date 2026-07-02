-- "Where should this go?" — a suggested home for an identified item, from where
-- its siblings already live (services/suggest-location.ts). Distinct from
-- target_location_id (the user's authoritative pick / note-extracted location):
-- this is a suggestion the review UI surfaces for one-tap accept, never applied
-- silently.
alter table core_scan_inbox_items add column if not exists suggested_location_id uuid;
alter table core_scan_inbox_items add column if not exists suggested_location_note text;
-- manual recovery if this fails partway:
--   ALTER TABLE core_scan_inbox_items DROP COLUMN suggested_location_id;
--   ALTER TABLE core_scan_inbox_items DROP COLUMN suggested_location_note;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0005_location_suggestion';
