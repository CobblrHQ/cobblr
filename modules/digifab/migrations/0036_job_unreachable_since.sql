-- When Cobblr last lost touch with a live job's manager. A poll that cannot
-- reach the manager keeps the job's status and backs off; the job is given up
-- only when the manager has been out of reach this long, not after a count of
-- misses, so a manager restart or a long network drop no longer fails a print
-- that kept running.
ALTER TABLE digifab_jobs ADD COLUMN IF NOT EXISTS unreachable_since timestamptz;
