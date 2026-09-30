-- A double-tapped Reprint makes one job. A reprint stamps its source job
-- (last_reprint_at, last_reprint_by) in one conditional UPDATE; the same
-- person reprinting the same job again within seconds is asked first instead
-- of starting a second physical print. A deliberate second copy says so.
ALTER TABLE digifab_jobs ADD COLUMN IF NOT EXISTS last_reprint_at timestamptz;
ALTER TABLE digifab_jobs ADD COLUMN IF NOT EXISTS last_reprint_by uuid;
