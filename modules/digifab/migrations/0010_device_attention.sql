-- Farm safety: a physical-acknowledgment gate between unattended prints.
--
-- When a print finishes (or fails), the printer's bed still holds the part —
-- it is NOT ready for the next job until a human clears it. Without this, the
-- pool assignment worker auto-advances the queue onto an occupied bed (a
-- head-crash / collision risk). A row here = "this device needs human attention
-- before it can take more work"; the assign worker skips any device with an open
-- row, and the fleet view surfaces it. A human clears it (POST …/ready), which
-- deletes the row.
--
-- Keyed by (connection_id, remote_device_id) — a device lives in at most one
-- attention state. connection_id is intentionally FK-free (connections live in
-- the platform device-connection store, not this DB — same as digifab_pool_members).
create table digifab_device_attention (
  connection_id     uuid not null,
  remote_device_id  text not null,
  job_id            uuid,                                  -- the print that left it occupied (nullable)
  reason            text not null default 'print-completed', -- print-completed | print-failed
  note              text,
  created_at        timestamptz not null default now(),
  primary key (connection_id, remote_device_id)
);

-- F-12: consecutive poll-error counter, so a transient blip while polling a live
-- print doesn't flip it to a permanent `failed`. Reset to 0 on a clean poll; a
-- job is only failed once this crosses the threshold (jobs-core.ts).
alter table digifab_jobs add column poll_errors int not null default 0;

-- manual recovery if this fails partway:
--   DROP TABLE digifab_device_attention;
--   ALTER TABLE digifab_jobs DROP COLUMN poll_errors;
