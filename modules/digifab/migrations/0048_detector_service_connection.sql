-- A detector's settings move onto a service connection (Services S8, #4034):
-- the adapter's connection holds the address and key, and this row keeps what
-- is per printer (the camera map) under that connection's id. Filled by the
-- detector heal; null until then, when the watch still reads the row directly.
ALTER TABLE digifab_detectors ADD COLUMN IF NOT EXISTS service_connection_id text;
CREATE INDEX IF NOT EXISTS digifab_detectors_service_connection_idx ON digifab_detectors (service_connection_id);
