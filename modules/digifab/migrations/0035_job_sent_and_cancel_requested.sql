-- When a job reached its printer, and when someone asked Cobblr to cancel it.
-- sent_at bounds how long a sent print may sit unstarted before it is failed
-- as "never started". cancel_requested_at lets a poll confirm a cancel from
-- the printer's own state instead of assuming it worked.
ALTER TABLE digifab_jobs ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE digifab_jobs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
