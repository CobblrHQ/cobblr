-- Queue depth:
--   priority      — higher sorts sooner in the assignment queue (default 0).
--   attempts      — how many times this job has been (re)sent.
--   max_attempts  — reprint-on-fail cap; a failed print with attempts < max goes
--                   back to the queue and re-sends instead of going terminal.
alter table digifab_jobs add column if not exists priority int not null default 0;
alter table digifab_jobs add column if not exists attempts int not null default 0;
alter table digifab_jobs add column if not exists max_attempts int not null default 1;
