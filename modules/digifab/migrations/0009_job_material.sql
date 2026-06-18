-- Phase 3 farm management: a job can declare the filament it consumes, so a
-- completed print deducts that material from inventory automatically (via a
-- seeded wire → inventory.adjust-stock). The job carries the part + grams; the
-- completion event payload surfaces them as { partId, delta } for the wire.

alter table digifab_jobs add column material_part_id uuid;   -- an inventory part (a filament spool)
alter table digifab_jobs add column material_grams numeric;  -- grams consumed; deducted on completion

-- manual recovery if this fails partway:
--   ALTER TABLE digifab_jobs DROP COLUMN material_part_id;
--   ALTER TABLE digifab_jobs DROP COLUMN material_grams;
