ALTER TABLE digifab_stations ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'laser';
ALTER TABLE digifab_stations ADD COLUMN IF NOT EXISTS machine_kind text;
ALTER TABLE digifab_stations ADD COLUMN IF NOT EXISTS machine_id uuid;
ALTER TABLE digifab_stations ALTER COLUMN connection_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS digifab_stations_machine ON digifab_stations(machine_id, purpose) WHERE revoked_at IS NULL;
