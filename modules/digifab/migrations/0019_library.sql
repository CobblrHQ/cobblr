-- The file library — stored 3MF / gcode files you send to machines, each with
-- the slicer-embedded plate thumbnail pulled out for preview. The file bytes live
-- in core-files (file_id); the extracted thumbnail is its own small core-files
-- image (thumbnail_file_id). plate_count = how many plates a 3MF carries.
create table if not exists digifab_library (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  file_id           uuid not null,
  thumbnail_file_id uuid,
  kind              text not null,        -- '3mf' | 'gcode'
  size_bytes        int not null default 0,
  plate_count       int not null default 1,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
