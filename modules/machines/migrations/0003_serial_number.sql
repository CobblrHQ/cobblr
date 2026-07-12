-- Serial number / service tag: a universal machine identifier every machine
-- (3D printer, laser, CNC, tool) tends to carry. Native + universal, relabelable
-- per bundle ("Serial", "Service tag", "VIN") — never a per-use-case field.
-- Nullable + no default so existing rows self-heal on deploy (no backfill).
--
-- manual recovery if this fails partway:
--   ALTER TABLE machines_machines DROP COLUMN serial_number;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0003_serial_number';
alter table machines_machines add column serial_number text;
