-- Server-managed custom fields. A field def marked server_managed carries a
-- value the SERVER computes/stamps (e.g. core-mobility's `away_since`) — a
-- client write is never accepted; the write router preserves the stored value
-- across an unrelated edit. Server-side writers (wire action handlers) write
-- the value directly, bypassing the request router.
--
-- Additive + defaulted, so it applies cleanly to every existing row
-- (false = an ordinary client-writable custom field, unchanged behaviour).
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP COLUMN server_managed;
--   DELETE FROM migrations WHERE name = 'platform::20260703-075-field-def-server-managed.sql';

ALTER TABLE module_field_defs
  ADD COLUMN server_managed boolean NOT NULL DEFAULT false;
