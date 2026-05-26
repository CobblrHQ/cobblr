-- Notifications gain a priority axis; subscriptions gain a
-- threshold. Together they let users say "send normal stuff to
-- in-app, high+ to Discord, urgent to SMS" instead of "everything
-- everywhere or nothing anywhere."
--
-- Backfill: defaults bake in the safe behaviour for existing rows.
--   - Every existing notification → priority = 'normal' (so it
--     surfaces at the standard threshold; we don't retroactively
--     declare anything to be 'urgent').
--   - Every existing subscription → min_priority = 'low' (the
--     floor; historical "in_app for event X" subscriptions keep
--     firing for every priority level they used to fire for).
--
-- The CHECK constraints lock the enum at the SQL layer so an
-- application bug can't write a garbage value.

alter table notifications
  add column priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent'));

alter table notification_subscriptions
  add column min_priority text not null default 'low'
    check (min_priority in ('low', 'normal', 'high', 'urgent'));

-- Add `sms` to the channel enum. Twilio driver lives at
-- api/src/platform/channels/sms.ts; user provides Twilio creds in
-- subscription.config. The CHECK constraint on the original
-- migration (20260515-001) didn't include sms; drop + recreate
-- with the expanded set.
alter table notification_subscriptions
  drop constraint notification_subscriptions_channel_check;
alter table notification_subscriptions
  add constraint notification_subscriptions_channel_check
    check (channel in ('in_app', 'browser_push', 'email', 'discord', 'webhook', 'slack', 'sms'));

-- Index supports the bell-badge query "how many unread notifications
-- at or above priority X" which the UI is about to start running.
create index notifications_priority_idx
  on notifications (org_id, user_id, priority);
