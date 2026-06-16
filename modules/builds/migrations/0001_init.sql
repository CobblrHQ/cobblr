-- builds — light bill-of-materials / assembly for the maker track.
--
-- A Build is a recipe (parent) made of components (lines), each pointing at an
-- inventory part + a per-build quantity. "Build one" consumes the components
-- from stock (via the inventory API, never a join); a BuildRun records what was
-- consumed. Tier 1: flat (no nested sub-assemblies — that's Tier 2).
--
-- Components reference inventory parts by id only (cross-module isolation —
-- builds never joins inventory_parts; it reads/writes through the inventory API).

create extension if not exists "pgcrypto";

create table builds_builds (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  description    text,
  -- The inventory part this build PRODUCES, if it becomes stock itself
  -- (optional — a one-off assembly produces nothing trackable).
  output_part_id uuid,
  output_qty     numeric not null default 1,
  notes          text,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table builds_components (
  id         uuid primary key default gen_random_uuid(),
  build_id   uuid not null references builds_builds(id) on delete cascade,
  -- The consumed inventory part (inventory:part id). NOT an FK — cross-module.
  part_id    uuid not null,
  quantity   numeric not null default 1,
  -- Optional components don't block "can I build" (counted separately).
  optional   boolean not null default false,
  notes      text,
  created_at timestamptz not null default now()
);

create index builds_components_build_idx on builds_components(build_id);

create table builds_runs (
  id         uuid primary key default gen_random_uuid(),
  build_id   uuid not null references builds_builds(id) on delete cascade,
  qty_built  numeric not null default 1,
  -- Snapshot of what was decremented: [{part_id, quantity}] — for audit/history.
  consumed   jsonb not null default '[]'::jsonb,
  built_by   uuid,
  built_at   timestamptz not null default now()
);

create index builds_runs_build_idx on builds_runs(build_id);
