-- The owner's five AI job groups (2026-10-10): "Identifying scans/photos in
-- the moment needs to be quick. Identifying things more thoroughly in the
-- scan inbox can take longer." Reading photos ('photos') splits into Quick
-- look ('glance') and Thorough reading ('reading').
--
-- Expand only: the check now takes both the old id and the new ones, and a
-- person's Reading photos steps are copied to both new jobs, so their scans
-- are answered as they were. The 'photos' rows stay for an api deployed
-- before this one (the canary reads this database too); this api never reads
-- them. A later contract migration removes them and 'photos' from the check.
ALTER TABLE user_ai_job_defaults DROP CONSTRAINT IF EXISTS user_ai_job_defaults_job_check;
ALTER TABLE user_ai_job_defaults
  ADD CONSTRAINT user_ai_job_defaults_job_check CHECK (job IN ('photos', 'glance', 'reading', 'chat', 'text', 'search'));

INSERT INTO user_ai_job_defaults (user_id, job, position, credential_id, model, model_follows)
SELECT user_id, j.job, position, credential_id, model, model_follows
FROM user_ai_job_defaults d
CROSS JOIN (VALUES ('glance'), ('reading')) AS j(job)
WHERE d.job = 'photos'
ON CONFLICT (user_id, job, position) DO NOTHING;
