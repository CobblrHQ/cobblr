-- core-locations: workspace-wide tree of physical places. Every
-- module that has location-bearing entities (inventory:part,
-- machines:machine, assets:asset, future kinds) references rows
-- here via a polymorphic location_id UUID.
--
-- The legacy `inventory_locations` table was inventory-owned but
-- conceptually cross-module; the boot-time migration at
-- api/src/platform/migrate-inventory-locations.ts copies rows into
-- this table preserving UUIDs so every existing location_id ref
-- across modules stays valid without rewrites.
--
-- Schema mirrors inventory_locations 1:1 so the copy is a single
-- INSERT…SELECT. Hierarchy via parent_id self-ref; depth cached
-- for cheap tree-render queries. kind narrows to 'area' vs
-- 'container' — coarse on purpose; users disambiguate via name.

create table core_locations_locations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  short_name  text,
  parent_id   uuid references core_locations_locations(id) on delete cascade,
  depth       integer not null default 0,
  kind        text not null default 'area'
                check (kind in ('container', 'area')),
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index core_locations_locations_parent_idx
  on core_locations_locations(parent_id);
