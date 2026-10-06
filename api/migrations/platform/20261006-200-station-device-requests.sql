-- A tablet that opens a station address asks to be approved: it shows a short
-- code, an owner or admin approves it from their own screen, and the tablet
-- then claims its own station token. Nothing is typed on the shared screen and
-- no token is stored here: the token is minted when the tablet claims it.
-- Only hashes of the code and of the tablet's poll key are kept.
CREATE TABLE IF NOT EXISTS station_device_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash    text NOT NULL UNIQUE,
  poll_hash    text NOT NULL,
  org_slug     text NOT NULL,
  address      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  approved_by  uuid REFERENCES users(id) ON DELETE CASCADE,
  approved_org uuid REFERENCES orgs(id) ON DELETE CASCADE,
  label        text,
  approved_at  timestamptz,
  claimed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS station_device_requests_expires ON station_device_requests (expires_at);
