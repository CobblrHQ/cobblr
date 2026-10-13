-- A recount's reconcile (#6302): what it changed when it was applied, kept on
-- the recount so its one Undo puts each record back exactly as it was. Never
-- a delete: gone keeps history, and things it added are marked gone on undo.
ALTER TABLE inventory_recounts ADD COLUMN IF NOT EXISTS truth boolean NOT NULL DEFAULT false;
ALTER TABLE inventory_recounts ADD COLUMN IF NOT EXISTS applied jsonb;
ALTER TABLE inventory_recounts ADD COLUMN IF NOT EXISTS applied_at timestamptz;
ALTER TABLE inventory_recounts ADD COLUMN IF NOT EXISTS applied_by uuid;
ALTER TABLE inventory_recounts ADD COLUMN IF NOT EXISTS undone_at timestamptz;
ALTER TABLE inventory_recounts ADD COLUMN IF NOT EXISTS undone_by uuid;
