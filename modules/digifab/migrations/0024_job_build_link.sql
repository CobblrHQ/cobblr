-- Link a fabrication job to a build (a bill-of-materials), so queuing the job —
-- e.g. sending a cut to a LightBurn laser — consumes that build's components
-- from inventory (and increments its output product). This is the "job-in →
-- subtract inventory → queue the machine, under one roof" path: the existing
-- builds:build-one action does the consumption; digifab just fires it on send.
--
-- build_consumed_at makes consumption idempotent — a re-send (reprint/recut on
-- failure) of an already-committed job won't double-deduct the materials.

alter table digifab_jobs add column linked_build_id uuid;
alter table digifab_jobs add column build_qty integer not null default 1;
alter table digifab_jobs add column build_consumed_at timestamptz;

-- manual recovery if this fails partway:
--   alter table digifab_jobs drop column if exists linked_build_id;
--   alter table digifab_jobs drop column if exists build_qty;
--   alter table digifab_jobs drop column if exists build_consumed_at;
--   delete from migrations where name = 'digifab::0024_job_build_link.sql';
