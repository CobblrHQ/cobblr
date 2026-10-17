-- How many notices each person's channel sent this hour (#6908), so a flood of
-- events cannot flood a channel: over the cap, a notice waits for that
-- channel's next digest. One row per (person, channel, hour), counted
-- atomically by an upsert; rows from past hours are pruned as new ones land.
create table if not exists notification_send_counts (
  user_id      uuid not null references users(id) on delete cascade,
  channel      text not null,
  window_start timestamptz not null,
  sends        integer not null default 0,
  primary key (user_id, channel, window_start)
);
