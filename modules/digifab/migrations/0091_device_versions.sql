-- What each connected device last said it runs (its driver's hourly read), so
-- a device not linked to a machine yet keeps its reading and hands it to the
-- machine the moment it is linked. One row per device, overwritten each read.
-- connection_id is FK-free, as in digifab_device_attention: connections live
-- in the platform's device-connection store.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS digifab_device_versions;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0071_device_versions';
create table if not exists digifab_device_versions (
  connection_id     uuid not null,
  remote_device_id  text not null,
  firmware          text,
  software          text,
  controller        text,
  model             text,
  seen_at           timestamptz not null default now(),
  primary key (connection_id, remote_device_id)
);
