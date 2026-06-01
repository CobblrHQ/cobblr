-- core-lists expiry sweep — dedupe ledger. The sweeper scans inventory parts
-- for an `expires_on` (a food-cluster custom field stored in inventory's
-- metadata jsonb) within the threshold and fires once per (part, expires_on).
-- core-lists can't add a column to the inventory table, so it tracks its own
-- "already alerted" state here. One row per part it has alerted on; the stored
-- expires_on lets a re-dated item re-alert.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_lists_expiry_notifications;
--   DELETE FROM migrations WHERE name LIKE '%module core-lists::0002_expiry_sweep.sql';

create table core_lists_expiry_notifications (
  part_id      text primary key,          -- inventory part id (cross-module ref; no FK)
  expires_on   date not null,             -- the value we alerted for
  notified_at  timestamptz not null default now()
);
