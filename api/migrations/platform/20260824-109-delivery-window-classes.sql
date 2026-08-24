-- Two cadences on one channel.
--
-- The window was per (person, channel), one cadence for everything. That cannot
-- express the shape people actually want, which is Discord live all day for
-- conversation AND one quiet morning brief of what is due today. Both of those
-- are priority `normal`, so no threshold can separate them: any bar that lets a
-- thread reply through lets the expiring cucumbers through with it.
--
-- What separates them is not urgency, it is what CAUSED the notification:
--
--   activity  — somebody did something. A reply, a mention, a parcel arriving.
--               News. You want it when it happens.
--   schedule  — a date arrived. Expiring today, service due, running low.
--               Knowable in advance, and better as one morning list than as
--               eleven interruptions spread over a Tuesday.
--
-- Still no use case named anywhere: "a date arrived" is a property of the
-- notification, exactly like priority is. Nothing here knows what a grocery is.
--
-- ADDITIVE ON PURPOSE, and specifically NOT a change to the primary key. The
-- obvious shape is a third key column, (user, channel, triggered_by), but that
-- means dropping the existing key, and under the canary channel an api that has
-- not been promoted yet still reads windows by (user, channel) — it would find
-- two rows where it expects one and pick arbitrarily, applying somebody's
-- morning-brief setting to their chat. Two extra columns on the same row cannot
-- do that: an old reader does not select them, and behaves exactly as before.

alter table notification_delivery_windows
  -- 'inherit' is what every existing row means today: one cadence, and dated
  -- things follow it. Nobody's delivery changes until they say otherwise.
  add column schedule_mode text not null default 'inherit'
    check (schedule_mode in ('inherit', 'immediate', 'daily')),

  add column schedule_deliver_at_minute integer not null default 480  -- 08:00
    check (schedule_deliver_at_minute between 0 and 1439),

  -- Its own idempotency stamp. The two windows open at different times, so one
  -- shared stamp would let whichever fired first suppress the other all day.
  add column schedule_last_delivered_at timestamptz;

-- Which window a queued item is waiting for. Without it the sweeper cannot tell
-- the morning brief from the evening chat backlog once both are in the bucket.
alter table notification_deferred
  add column triggered_by text not null default 'activity'
    check (triggered_by in ('activity', 'schedule'));

-- The sweeper reads one bucket at a time and a bucket is now per class.
drop index if exists notification_deferred_bucket_idx;
create index notification_deferred_bucket_idx
  on notification_deferred (user_id, channel, triggered_by, queued_at);
