-- core-devices — the device substrate beyond digifab (see
-- docs/architecture/core-devices-extraction.md). PR 1: the device → entity LINK.
--
-- ONE source of truth for "which Cobblr entity does this device feed", surfaced
-- two ways: a central admin (all rows) and a per-entity field (rows for one
-- entity). A wire then turns a device event into an action on the linked entity
-- (scale → a part's stock, RFID tap → an asset loan, counter → a build run).

create table core_devices_links (
  id            uuid primary key default gen_random_uuid(),
  -- The device's connection. Today a digifab connection id (logical ref — the
  -- connections table moves to core-devices in a later PR); not FK-enforced
  -- across modules.
  connection_id uuid not null,
  -- The logical device id on the chip / bridge ("scale", "badge", "beam").
  device        text not null,
  -- The Cobblr entity this device feeds.
  entity_kind   text not null,   -- "inventory:part" | "assets:asset" | "builds:build" | …
  entity_id     uuid not null,
  -- How a device event maps onto the entity.
  mode          text not null default 'set',   -- set | add | log | loan
  -- Mode-specific detail, e.g. { "field": "stock_qty", "unit": "g" }.
  config        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One link per (device, entity) pair.
  unique (connection_id, device, entity_kind, entity_id)
);

-- Surface B (per-entity field): "what feeds THIS part?"
create index core_devices_links_entity_idx on core_devices_links (entity_kind, entity_id);
-- Event resolution: "(connection, device) → which entity?"
create index core_devices_links_device_idx on core_devices_links (connection_id, device);

-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_devices_links;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0001_init';
