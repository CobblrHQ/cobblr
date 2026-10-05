CREATE TABLE IF NOT EXISTS digifab_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  remote_device_id text NOT NULL,
  label text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
