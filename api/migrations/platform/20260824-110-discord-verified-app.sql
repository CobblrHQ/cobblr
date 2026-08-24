-- Which Discord APP proved a connection deliverable.
--
-- `verified` records that a test DM arrived. It does not record WHO sent it,
-- and that turns out to matter: a DM channel belongs to a bot, not to Cobblr.
-- Point the server at a different Discord application and every existing row
-- still says `verified: true` while the new bot may have no way to reach that
-- person at all — a bot can only DM someone it shares a server with, and the
-- old bot's permission does not transfer.
--
-- Nothing errors in that state. notifications.ts records
-- `outcomes.discord_dm = "blocked"` and moves on, so the person simply stops
-- hearing anything and neither they nor the operator finds out.
--
-- Stamping the app id makes the switch DETECTABLE: a connection whose stamp
-- does not match the configured app is treated as unverified and re-proven with
-- a fresh test DM, which is the only thing that actually establishes the new
-- bot can reach them.
--
-- NULL means "verified before this column existed". Those are grandfathered on
-- first read and stamped with whatever app is configured then, so deploying
-- this prompts nobody; only a genuine app CHANGE does.
--
-- manual recovery:
--   ALTER TABLE discord_connections DROP COLUMN IF EXISTS verified_app_id;

alter table discord_connections
  add column if not exists verified_app_id text;

comment on column discord_connections.verified_app_id is
  'Discord application id whose test DM proved this connection. NULL = predates the column (grandfathered on read). A mismatch with the configured app means re-verify.';
