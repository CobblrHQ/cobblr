-- Loaded spools (#4016). A printer holds the spools loaded on it as placements
-- (core-placement, one per slot); this is what digifab needs beside them.
--
-- material_grams_by_tool: the slicer's grams per filament, tool 1 first, so a
--   multi-material print draws on the spool in each slot rather than one.
-- material_drawn: what a completed print took off which spool, so a scrapped
--   print puts back exactly that ([{part_id, grams, slot}]).
-- digifab_machine_slots: how many filament slots a printer has (1 for a plain
--   printer, 4 with an AMS, 5 on an MMU).
alter table digifab_jobs add column if not exists material_grams_by_tool jsonb;
alter table digifab_jobs add column if not exists material_drawn jsonb;

create table if not exists digifab_machine_slots (
  machine_id text primary key,
  slots      integer not null default 1 check (slots between 1 and 64),
  updated_at timestamptz not null default now()
);
