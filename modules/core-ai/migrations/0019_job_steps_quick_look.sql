-- The owner's five AI job groups (2026-10-10): Reading photos ('photos')
-- splits into Quick look ('glance') and Thorough reading ('reading'). A
-- workspace's order for Reading photos (0018) seeds both, so its scans are
-- answered as they were. The 'photos' rows stay for an api deployed before
-- this one; this api never reads them.
insert into core_ai_job_steps (job, position, credential_id, provider_id, model, model_follows, updated_by)
select j.job, position, credential_id, provider_id, model, model_follows, updated_by
from core_ai_job_steps s
cross join (values ('glance'), ('reading')) as j(job)
where s.job = 'photos'
on conflict (job, position) do nothing;
