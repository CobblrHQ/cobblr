-- Where a feedback item came from, so resolutions can route back to the right
-- channel. 'in-app' (the FeedbackWidget — replies via in-app notification +
-- email) or 'discord' (a #support ticket — replies posted into its thread by
-- the support bot). A discord ticket has no Cobblr user, so user_id becomes
-- nullable and the reporter identity lives in origin_ref.
--
-- origin_ref (discord): { channel_id, thread_id, message_id, user_id, username }
--
-- manual recovery if this fails partway:
--   ALTER TABLE feedback DROP COLUMN IF EXISTS origin, DROP COLUMN IF EXISTS origin_ref;
--   ALTER TABLE feedback ALTER COLUMN user_id SET NOT NULL;  -- only if no discord rows exist
--   DELETE FROM migrations WHERE name = '20260609-051-feedback-origin.sql';

alter table feedback
  add column origin text not null default 'in-app',
  add column origin_ref jsonb;

-- discord tickets have no platform user — the reporter is in origin_ref.
alter table feedback alter column user_id drop not null;
