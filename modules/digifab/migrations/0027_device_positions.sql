-- ⑦ Spatial floor layout (FDMM's floors, single-floor version): a device can be
-- pinned to a grid cell so the fleet mirrors the physical shop. Null = unplaced
-- (flows after the placed ones).
alter table digifab_device_settings add column if not exists grid_x integer;
alter table digifab_device_settings add column if not exists grid_y integer;
-- manual recovery if this fails partway:
--   ALTER TABLE digifab_device_settings DROP COLUMN grid_x;
--   ALTER TABLE digifab_device_settings DROP COLUMN grid_y;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0027_device_positions';
