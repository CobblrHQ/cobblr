-- A receipt session's read is a STATE on the session, never an inbox item.
-- read_state: in_flight | read | failed (null = a plain scan session, or a
-- receipt session from before this column, judged by its lines).
-- read_failure: the last failure with the router's coded reason and every
-- attempt (platform-contract scan-session.ts). read_started_at / read_at: the
-- clock the row's "reading…" and "read" come from, never the absence of rows.
alter table core_scan_batches
  add column if not exists read_state      text,
  add column if not exists read_failure    jsonb,
  add column if not exists read_started_at timestamptz,
  add column if not exists read_at         timestamptz;
