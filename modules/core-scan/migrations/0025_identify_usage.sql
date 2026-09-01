-- The per-workspace allowance for hosted identification ("N a day, free") lived
-- in an in-memory Map. A restart handed every workspace a fresh N, and more than
-- one api runs against a tenant database (the canary channel, every rolling
-- deploy), so the cap was per PROCESS and N quietly became 2N. Acceptable for an
-- hour-long sandbox; not for the number a hosted product advertises.
--
-- One row per UTC day, per tenant. The claim is a single atomic upsert
-- (insert-or-increment, guarded by n < cap in the same statement), so two api
-- processes cannot both be granted the last unit.
create table if not exists core_scan_identify_usage (
  day date    primary key,
  n   integer not null default 0
);
