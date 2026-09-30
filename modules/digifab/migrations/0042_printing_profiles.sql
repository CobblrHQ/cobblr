-- A machine's Printing profile (Services §14.3): what a slicer needs to know
-- about the printer, kept once per machine and read by every slicer a
-- workspace connects. `printer_model` is a neutral id ("bambulab/a1") each
-- slicer maps to its own presets; `build_volume_mm` is [x, y, z];
-- `preset_hints` maps a filament type's id to the slicer preset to prefer for
-- it on this printer. digifab.pick-printer reads it to say whether a part fits
-- and which profile a slice should use.
create table if not exists digifab_printing_profiles (
  machine_id text primary key,
  printer_model text,
  nozzle_mm numeric,
  build_volume_mm jsonb,
  default_quality text,
  preset_hints jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
