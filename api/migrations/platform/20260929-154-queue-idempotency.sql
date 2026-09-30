-- A queued job can say what it is (an idempotency key), so enqueueing the same
-- thing twice while the first is still waiting or running is one job, not two.
-- Services' poller is the first user: one poll chain per service job, however
-- often a restart or a retry asks for it (services.md §10).
alter table core_queue_jobs add column if not exists idempotency_key text;

create unique index if not exists core_queue_jobs_idempotency_idx
  on core_queue_jobs (org_id, queue, idempotency_key)
  where idempotency_key is not null and status in ('queued', 'running');
