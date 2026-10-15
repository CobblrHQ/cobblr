-- When a per-workspace boot sweep last ran clean, and at which version of its
-- own code.
--
-- A historical shim that opens every workspace's database finds nothing once
-- its work is done: its writer is fixed, or its signup-time twin makes every
-- new workspace right. It still opened 471 tenant pools on every staging boot,
-- about a minute per pass, four passes, before the api could listen (#6707).
--
-- A sweep that finishes with no workspace failing records its code version
-- here. The next boot skips it while the version matches and the mark is under
-- a week old: a change to the pass re-arms it, and a weekly full run keeps its
-- DONE WHEN measured.
create table if not exists boot_sweep_marks (
  pass      text primary key,
  version   text not null,
  swept_at  timestamptz not null
);
