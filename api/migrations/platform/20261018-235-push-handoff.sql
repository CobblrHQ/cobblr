-- Turning on push asks which other channels to turn off (#7070). Additive.

-- When the person was asked, once, after their first push device: answered
-- or skipped, it is not asked again. NULL: not yet asked.
ALTER TABLE push_settings ADD COLUMN IF NOT EXISTS handoff_asked_at timestamptz;

-- A personal channel the person turned off for their workspace updates: the
-- dispatcher sends nothing there, whatever a subscription or an account
-- default says. A row is "off"; no row is as before. Account notices (a
-- feedback reply, a sign-in alert) are not workspace updates and still go.
CREATE TABLE IF NOT EXISTS notification_channels_off (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL,
  turned_off_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel)
);
