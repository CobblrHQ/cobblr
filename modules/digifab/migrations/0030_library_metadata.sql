-- Slicer metadata on library files (the PFM "parse the filename" steal, done
-- properly: gcode header comments first, filename convention as fallback).
-- Parsed once at upload; prefills production-run forms (parts-per-plate) and
-- gives the library list its material / est-time chips.
alter table digifab_library add column metadata jsonb not null default '{}'::jsonb;

-- manual recovery if this fails partway:
--   ALTER TABLE digifab_library DROP COLUMN IF EXISTS metadata;
