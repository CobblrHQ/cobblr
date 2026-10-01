-- How many times something happened in a workspace on a UTC day, for the
-- operator's usage stats: identifications served (barcode and vision, hit and
-- miss) and scans. A counter, not a row per occurrence: a scanning session can
-- make hundreds of lookups, and the question is only "how many".
create table if not exists product_daily_counts (
  day     date    not null,
  org_id  uuid    not null references orgs(id) on delete cascade,
  metric  text    not null,
  n       integer not null default 0,
  primary key (day, org_id, metric)
);
