-- The substance behind a notification's one-line message, persisted.
--
-- Dispatch already builds a card — heading, body, context — and hands it to
-- channels that can render one: the Discord DM shows the comment you were
-- mentioned in as an embed. The bell could not, because the card was never
-- stored: the in-app row kept only the one-liner, so the app's own inbox had
-- the exact problem the DM was just cured of ("X mentioned you in Y" — open
-- the conversation to find out what was said, having been told only that
-- something was).
--
-- One jsonb document, written once at dispatch, shape owned by the contract's
-- NotificationCard. NULL for the majority of notifications that have no more
-- substance than their message.
--
-- manual recovery:
--   ALTER TABLE notifications DROP COLUMN IF EXISTS card;

alter table notifications
  add column if not exists card jsonb;

comment on column notifications.card is
  'Optional NotificationCard {heading, body, context} — the substance behind message. Written at dispatch; rendered by surfaces that can show more than one line.';
