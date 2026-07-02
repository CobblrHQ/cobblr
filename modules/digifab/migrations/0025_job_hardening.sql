-- Farm-hardening audit 2026-07-02.
-- build_reversed_at: the reversal-side twin of build_consumed_at — a scrapped/
-- failed/cancelled job whose build was committed at send gets its consumption
-- reversed exactly once (null→now atomic flip, same idempotency pattern).
alter table digifab_jobs add column if not exists build_reversed_at timestamptz;

-- Hot-path indexes the audit found missing: the jobs list sorts created_at desc,
-- history windows filter status+updated_at, the assign worker's busy-set filters
-- bare status.
create index if not exists digifab_jobs_created_at_idx on digifab_jobs (created_at desc);
create index if not exists digifab_jobs_status_idx on digifab_jobs (status);
create index if not exists digifab_jobs_updated_at_idx on digifab_jobs (updated_at);

-- manual recovery if this fails partway:
--   ALTER TABLE digifab_jobs DROP COLUMN build_reversed_at;
--   DROP INDEX IF EXISTS digifab_jobs_created_at_idx;
--   DROP INDEX IF EXISTS digifab_jobs_status_idx;
--   DROP INDEX IF EXISTS digifab_jobs_updated_at_idx;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0025_job_hardening';
