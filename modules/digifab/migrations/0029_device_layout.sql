-- Free-form fleet layout: the tiles themselves are the floor. An ordered
-- sequence (sort_order) with explicit row breaks (row_break = this machine
-- starts a new row) replaces the 0027 cell grid UI — rows can be partial, and
-- machines with no saved order flow in a trailing row. Per-workspace (these
-- settings rows are workspace data).
--
-- manual recovery if this fails partway:
--   ALTER TABLE digifab_device_settings DROP COLUMN IF EXISTS sort_order, DROP COLUMN IF EXISTS row_break;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0029_device_layout';
ALTER TABLE digifab_device_settings
  ADD COLUMN IF NOT EXISTS sort_order integer,
  ADD COLUMN IF NOT EXISTS row_break boolean NOT NULL DEFAULT false;
