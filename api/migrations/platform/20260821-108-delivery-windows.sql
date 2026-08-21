-- Delivery windows: when a message arrives is the person's setting.
--
-- Design: docs/design-decisions/notification-delivery-windows.md
--
-- The problem this exists for is volume, not urgency. The priority ladder
-- already decides WHETHER a channel hears about something; nothing decided how
-- OFTEN. A workspace with forty tracked consumables would DM forty times a day,
-- each one perfectly debounced by core_cadence_signals and the whole set still
-- unusable. A muted channel then fails silently, which is the expensive kind.
--
-- Grain matters: the window is per (person, CHANNEL), deliberately not per
-- event type like notification_subscriptions and notification_account_prefs.
-- The entire point is ONE message across every event, so a per-event setting
-- could not express it.

create table notification_delivery_windows (
  user_id            uuid not null references users(id) on delete cascade,
  channel            text not null,

  -- 'immediate' is today's behaviour and stays the default for every existing
  -- row and channel. Only a channel a person has explicitly windowed defers.
  mode               text not null default 'immediate'
                       check (mode in ('immediate', 'daily')),

  -- Minutes past local midnight. An integer rather than a `time` so the
  -- arithmetic the sweeper does (has this window opened yet today?) is plain
  -- comparison in any timezone.
  deliver_at_minute  integer not null default 480   -- 08:00
                       check (deliver_at_minute between 0 and 1439),
  -- IANA zone. 08:00 has to mean 08:00 where the person is, or a digest called
  -- "morning" arrives at teatime for half its audience.
  timezone           text not null default 'UTC',

  -- Idempotency for the sweeper: one flush per window per day, so a tick that
  -- runs twice (restart, overlap) cannot send the digest twice.
  last_delivered_at  timestamptz,

  updated_at         timestamptz not null default now(),
  primary key (user_id, channel)
);

-- The bucket a deferred notification waits in.
--
-- Rows here are ALREADY recorded in `notifications` (the dispatcher inserts
-- there first, unconditionally, so the bell and the history are never affected
-- by a delivery window). This table holds only what a windowed channel still
-- owes the person.
create table notification_deferred (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  channel          text not null,
  -- The notification this defers. Cascades, so clearing history cannot leave
  -- an orphan queued for delivery.
  notification_id  uuid not null references notifications(id) on delete cascade,
  org_id           uuid,
  event_type       text not null,
  message          text not null,
  link_url         text,
  priority         text not null default 'normal',
  queued_at        timestamptz not null default now()
);

-- The read is always "everything this person is owed on this channel, oldest
-- first", which is also the order the digest reads in.
create index notification_deferred_bucket_idx
  on notification_deferred (user_id, channel, queued_at);

-- The sweeper's own scan: which buckets have anything in them at all. Without
-- this it walks every user on the box each tick to find the few with mail.
create index notification_deferred_pending_idx
  on notification_deferred (channel, queued_at);
