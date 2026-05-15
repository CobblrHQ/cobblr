-- Machines — a generic base module for "a physical thing I own
-- that does something on its own." Common fields only. Anything
-- type-specific (printer hotend, laser tube_type, CNC spindle)
-- comes from a Pillar-E specialisation module (3d-printers,
-- laser-cutters, cnc-machines) that depends on this one.

create table machines_machines (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  short_name    text,
  family        text,
  type          text,
  manufacturer  text,
  state         text not null default 'functional',
  excitement    int default 0,
  image_path    text,
  notes         text,
  quantity      int default 1,
  -- Polymorphic location pointer. UUID; not enforced as FK because
  -- inventory:location lives in its own module's tenant tables and
  -- cross-module FKs are forbidden.
  location_id   uuid,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index machines_machines_state_idx on machines_machines(state);
create index machines_machines_family_idx on machines_machines(family);
