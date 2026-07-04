-- Record the filament MATERIAL (a slicer type token like "PLA"/"PETG"), separate
-- from material_part_id (which inventory spool). Auto-filled from the picked
-- gcode/3MF slicer metadata in the New-job modal, so the material is captured
-- even when no spool is matched. Nullable — legacy jobs and manual entries stay
-- fine; grams-deduction still keys on material_part_id, this is a record + display.

alter table digifab_jobs add column material_type text;   -- filament type: PLA, PETG, ABS, … (from the slicer)

-- manual recovery if this fails partway:
--   ALTER TABLE digifab_jobs DROP COLUMN material_type;
