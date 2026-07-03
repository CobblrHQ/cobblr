-- Durable per-connection device-list cache for the fleet view: the last
-- successful listDevices() result, served stale-while-revalidate so the floor
-- paints instantly (cold process start included) while a background refresh
-- fetches live state. One row per connection, overwritten on every refresh.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS digifab_fleet_device_cache;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0028_fleet_device_cache';
CREATE TABLE IF NOT EXISTS digifab_fleet_device_cache (
  connection_id text PRIMARY KEY,
  devices jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
