-- An action fired by an event and nothing else: its record is named by the
-- event's payload, so asked in words there is nothing to act on, and the
-- assistant must not be offered it (a task by linkedTaskId, an inbox row by
-- the scan). Its own flag, because `user_invokable` is the BUTTON flag ("no
-- button on the record's page") and is false on plenty of actions the
-- assistant runs every day; reading that as wire-only took twelve of them off
-- the rail (2026-09-14). Additive with a default so every row reads false
-- until registry-sync rewrites the real value from each manifest on boot.
ALTER TABLE entity_actions
  ADD COLUMN IF NOT EXISTS wire_only boolean NOT NULL DEFAULT false;
