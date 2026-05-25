-- Track when the "due-soon" sweeper last notified the workspace
-- about this scheduled entry, so we don't re-notify every hour. The
-- sweeper notifies once per (entry, scheduled_at) — if a user
-- reschedules the entry the new scheduled_at > last_notified_at and
-- they get a fresh ping.

alter table core_maintenance_entries
  add column last_notified_at timestamptz;

create index core_maintenance_notify_idx
  on core_maintenance_entries (scheduled_at)
  where scheduled_at is not null and performed_at is null;
