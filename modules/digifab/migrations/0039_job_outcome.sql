-- A job's outcome: how many came off the plate good and how many were scrap
-- (#4050). Parts count as made when they are judged good, not when the file
-- is sent: a print that fails or is scrapped adds nothing to stock.
--
--   outcome            'good' (some came out good) | 'scrap' (none did); null until judged
--   outcome_good_qty   builds made good on this job
--   outcome_scrap_qty  builds lost on this job
--   outcome_at         set once, by a null→now flip, so a re-verdict never counts twice
--   outcome_source     'bed-clear' (a person's verdict) | 'print-failed' | 'auto' (no bed to clear)
alter table digifab_jobs add column if not exists outcome text;
alter table digifab_jobs add column if not exists outcome_good_qty int;
alter table digifab_jobs add column if not exists outcome_scrap_qty int;
alter table digifab_jobs add column if not exists outcome_at timestamptz;
alter table digifab_jobs add column if not exists outcome_source text;

-- The build's output waits for the good verdict. A job committed before this
-- change credited its output at send; build_output_deferred tells the two
-- apart so that job is never credited a second time at its verdict, and a
-- scrap still takes back what it was given.
alter table digifab_jobs add column if not exists build_output_deferred boolean not null default false;
alter table digifab_jobs add column if not exists build_output_at timestamptz;
