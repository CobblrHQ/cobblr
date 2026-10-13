-- A thing a recount noted as new that reads as one of its collection's TYPES
-- (a Kingroon PETG white spool, in a Spools collection whose types live in
-- Filament Types): added under that type when the recount is finished (#6302).
ALTER TABLE inventory_recount_scans ADD COLUMN IF NOT EXISTS like_type_id uuid;
