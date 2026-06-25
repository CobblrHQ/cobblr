-- Give observed prints an IN-PROGRESS lifecycle: a print started ON the machine
-- (not via Cobblr) is recorded the moment it starts (status 'printing', ended_at
-- NULL) so it shows in the print list while running, then closed to
-- 'completed'/'failed' on finish. Previously a row was only written on completion,
-- so a running externally-started print appeared in no list.
alter table digifab_observed_prints alter column ended_at drop not null;
