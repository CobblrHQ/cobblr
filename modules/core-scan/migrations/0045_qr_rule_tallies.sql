-- How often each resolver rule matched a scan, and how often that scan named
-- more than one thing (#6892, scan-serial-number-resolution.md D6). A day's
-- row per rule; the rules page reads the last 30 days ("matched more than one
-- thing in 14 of 212 scans"), so a workspace whose serials are outgrowing
-- their length can see it. Counts only: no value scanned is kept.
create table if not exists core_scan_qr_rule_tallies (
  rule_id uuid not null references core_scan_qr_rules(id) on delete cascade,
  day date not null,
  scans integer not null default 0,
  ambiguous integer not null default 0,
  primary key (rule_id, day)
);
