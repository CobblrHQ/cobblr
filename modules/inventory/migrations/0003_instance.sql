-- Multi-instance support — see docs/design-decisions/instances.md.
--
-- Inventory has four tables; three of them are user-data tables that
-- need the instance column. inventory_locations was already moved to
-- core-locations in 0002_locations_moved_to_core.sql so it's a no-op
-- here.
--
-- inventory_categories' unique constraint on slug becomes per-instance.
-- inventory_parts gets its name index extended to include instance for
-- query plan efficiency.

alter table inventory_parts
  add column instance text not null default 'inventory';
create index inventory_parts_instance_idx on inventory_parts(instance);

alter table inventory_categories
  add column instance text not null default 'inventory';

-- Replace the workspace-wide slug uniqueness with instance-scoped
-- uniqueness. Same slug can repeat across instances ("bolts" in
-- screws + "bolts" in electrical).
alter table inventory_categories drop constraint if exists inventory_categories_slug_key;
create unique index inventory_categories_instance_slug_idx
  on inventory_categories(instance, slug);

alter table inventory_allocations
  add column instance text not null default 'inventory';
create index inventory_allocations_instance_idx on inventory_allocations(instance);
