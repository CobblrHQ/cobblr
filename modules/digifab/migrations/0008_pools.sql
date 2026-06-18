-- Phase 2 farm management: Cobblr-native POOLS + a cross-machine queue.
--
-- A pool is a set of devices (possibly spanning connections — each individual
-- OctoPrint/Klipper can be its own connection, so a pool is how you aggregate a
-- pile of printers into one farm). A job that targets a pool is created
-- UNASSIGNED — no connection, no device — and the assignment worker drips it
-- onto a free member as printers come idle. This is coordinate-not-control at
-- fleet scale: the worker only picks which manager+printer gets the file.

-- A pool job has no connection until the worker assigns it, so connection_id
-- must be nullable.
alter table digifab_jobs alter column connection_id drop not null;

-- The connection record moved to the platform device-connection store
-- (core_devices_connections, meta DB) in the core-devices extraction, but
-- digifab_jobs still carried a FK to the OLD local digifab_connections copy.
-- That stale FK rejects valid store-managed connection ids — e.g. when the
-- assignment worker stamps a pool job's connection. Drop it; the store is the
-- source of truth for connections (a direct INSERT with connection_id worked
-- only because the old copy was backfilled; an assign-time UPDATE to a freshly
-- created connection isn't in that copy). Cascade-on-delete is moot now too —
-- connections are deleted through the store, not this table.
alter table digifab_jobs drop constraint if exists digifab_jobs_connection_id_fkey;

-- digifab_device_links carries the SAME stale FK (created as digifab_printer_links
-- in 0003 → the constraint keeps its original name through the 0007 rename). Linking
-- a device to a store-created connection would fail identically — drop it too.
alter table digifab_device_links drop constraint if exists digifab_printer_links_connection_id_fkey;
alter table digifab_device_links drop constraint if exists digifab_device_links_connection_id_fkey;

-- Third targeting mode alongside target_device / target_tag.
alter table digifab_jobs add column target_pool uuid;

create table digifab_pools (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A device lives in at most one pool (PK across the triple). connection_id is
-- intentionally FK-free — the live connection record lives in the platform
-- device-connection store (core_devices_connections, meta DB), not here.
create table digifab_pool_members (
  pool_id           uuid not null references digifab_pools(id) on delete cascade,
  connection_id     uuid not null,
  remote_device_id  text not null,
  loaded_material   text,                              -- Phase 3 hint; null for now
  created_at        timestamptz not null default now(),
  primary key (pool_id, connection_id, remote_device_id)
);

create index digifab_jobs_pool_idx on digifab_jobs(target_pool, status);

-- manual recovery if this fails partway (module migrations are file-tracked):
--   ALTER TABLE digifab_jobs DROP COLUMN target_pool;
--   ALTER TABLE digifab_jobs ALTER COLUMN connection_id SET NOT NULL; -- only if no null rows
--   DROP TABLE digifab_pool_members; DROP TABLE digifab_pools;
