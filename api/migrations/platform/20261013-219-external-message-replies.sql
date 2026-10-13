-- The answer someone outside a workspace gave an automation's message (#6070,
-- slice 3b). A wire may add a reply link to its message: a signed page with
-- "Got it" and "Bought it" and nothing else of the workspace. The answer is
-- kept on the message it answers, once: a second press changes nothing.
--
-- Additive + safe: two nullable columns.
--
-- manual recovery if this fails partway:
--   ALTER TABLE external_message_log DROP COLUMN IF EXISTS reply, DROP COLUMN IF EXISTS replied_at;
--   DELETE FROM migrations WHERE name = '20261013-219-external-message-replies.sql';

alter table external_message_log
  add column if not exists reply text,
  add column if not exists replied_at timestamptz;
