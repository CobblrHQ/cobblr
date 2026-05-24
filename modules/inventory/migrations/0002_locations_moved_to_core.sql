-- Locations graduated from `inventory:location` (inventory-owned) to
-- `core-locations:location` (foundational, cross-module). The rows
-- themselves move via the one-shot boot migration in
-- api/src/platform/migrate-inventory-locations.ts — that runs BEFORE
-- this file, so by the time we drop the table the data already lives
-- in core_locations_locations with UUIDs preserved.
--
-- inventory_parts.location_id stays as a plain UUID column (no FK)
-- pointing at core_locations_locations rows. Its FK constraint was
-- dropped by the same boot migration.
--
-- Idempotent. For brand-new orgs, 0001 creates inventory_locations
-- and then this migration immediately drops it — no data loss
-- because no rows have been inserted yet.

drop table if exists inventory_locations cascade;
