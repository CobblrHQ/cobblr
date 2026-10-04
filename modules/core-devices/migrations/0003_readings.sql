CREATE TABLE IF NOT EXISTS core_devices_readings (
  link_id uuid PRIMARY KEY REFERENCES core_devices_links(id) ON DELETE CASCADE,
  value double precision NOT NULL DEFAULT 0,
  unit text,
  sampled_at timestamptz NOT NULL DEFAULT now()
);
