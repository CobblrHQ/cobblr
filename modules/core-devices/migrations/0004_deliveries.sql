-- A device's delivery ids, so a post it sends again after losing the answer
-- (a counter's delta, an RFID tap) is applied once. Kept a week.
CREATE TABLE IF NOT EXISTS core_devices_deliveries (
  connection_id text NOT NULL,
  device text NOT NULL,
  delivery text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, device, delivery)
);
CREATE INDEX IF NOT EXISTS core_devices_deliveries_received_at ON core_devices_deliveries (connection_id, device, received_at);
