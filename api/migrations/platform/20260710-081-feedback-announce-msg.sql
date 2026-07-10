-- Remember WHICH Discord "New feedback" post a feedback item produced, so the
-- item's lifecycle can be reflected back onto that same message as emoji
-- reactions (🤖 grabbed → 🔨 building → 👀 PR up → 📋 spec → ✅ shipped → 🚫
-- passed). announce() posts feedback.new with ?wait=true and Discord echoes the
-- created message; we stash its id + channel here. The support bot (which holds
-- the Discord gateway connection) then reacts to it as the item is worked.
--
-- Nullable + additive: an item posted while the announce category is disabled,
-- or before this column existed, simply has no message to react to — the bot
-- no-ops. No backfill needed.
--
-- manual recovery if this fails partway:
--   ALTER TABLE feedback DROP COLUMN IF EXISTS announce_message_id, DROP COLUMN IF EXISTS announce_channel_id;
--   DELETE FROM migrations WHERE name = '20260710-081-feedback-announce-msg.sql';

alter table feedback
  add column if not exists announce_message_id text,
  add column if not exists announce_channel_id text;
