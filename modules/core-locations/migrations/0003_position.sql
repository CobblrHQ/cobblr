-- Manual sibling ordering for the locations tree. Additive: a single integer
-- column, default 0, so every existing row keeps the current (alpha) order
-- until the user drags/arrows one — buildTree breaks ties by name. Siblings are
-- ordered by (position, name); position is set by POST /locations/reorder.
--
-- manual recovery if this fails partway:
--   ALTER TABLE core_locations_locations DROP COLUMN position;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0003_position';
alter table core_locations_locations add column position integer not null default 0;
