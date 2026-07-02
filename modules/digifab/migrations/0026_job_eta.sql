-- Farm view: persist the driver-reported time-remaining on the job so the fleet
-- tile can say "~done 15:42" (pollJob receives it every poll but only kept it
-- in memory). Nullable; drivers that don't report it leave it null.
alter table digifab_jobs add column if not exists eta_sec integer;
-- manual recovery if this fails partway:
--   ALTER TABLE digifab_jobs DROP COLUMN eta_sec;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0026_job_eta';
