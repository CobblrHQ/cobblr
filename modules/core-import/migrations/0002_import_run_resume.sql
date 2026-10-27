-- A spreadsheet import carries on after the server restarts (#8656).
--
-- A run cut off by a restart said "running" forever: the queue handed its
-- job to the new server, which saw a run already running and dropped it, so
-- the rest of the rows never came and Undo refused while it "ran". A run now
-- beats while it works, and keeps where it had got to, so a job that finds
-- it running with no beat for a while takes it over and carries on from
-- there. Kept beside the plan, not in it: the plan holds every row and is
-- never rewritten while the run works.

alter table core_import_runs add column if not exists heartbeat_at timestamptz;
alter table core_import_runs add column if not exists resume jsonb;
