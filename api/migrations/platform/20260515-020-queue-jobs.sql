-- core-queue v0.1: persistent background work.
--
-- Jobs are enqueued from any module via platform.queue.enqueue().
-- A worker loop in the api process polls the ready set every 5s,
-- locks one row via SELECT FOR UPDATE SKIP LOCKED (so multiple api
-- instances can race without colliding), invokes the registered
-- handler, then either marks done or schedules a retry.
--
-- Jobs ARE org-scoped (org_id required) — every meaningful unit of
-- background work happens for some workspace. Platform-wide chores
-- like "rotate JWT secret" run synchronously at boot, not through
-- the queue.

create table core_queue_jobs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  queue         text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'queued',
  attempts      int  not null default 0,
  max_attempts  int  not null default 3,
  -- When the job should next run. Set on enqueue (defaults to now)
  -- and bumped on retry by the exponential-backoff formula.
  run_at        timestamptz not null default now(),
  -- Lock identifies the worker that grabbed this job. Cleared on
  -- complete/fail. A stale lock (locked_at older than ~15min) is
  -- treated as crashed and the job goes back to 'queued'.
  locked_at     timestamptz,
  locked_by     text,
  completed_at  timestamptz,
  failed_at     timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  check (status in ('queued', 'running', 'done', 'failed'))
);

-- "Ready to run" index: cheap WHERE ... AND run_at <= now() scan.
create index core_queue_jobs_ready_idx
  on core_queue_jobs(queue, run_at)
  where status = 'queued';

-- Stale-lock sweep index — used by the worker to reclaim jobs
-- whose worker crashed mid-execution.
create index core_queue_jobs_locked_idx
  on core_queue_jobs(locked_at)
  where status = 'running';

-- Per-org view of recent jobs for a future per-org "background
-- work" UI page; not currently consumed but indexed for cheap reads.
create index core_queue_jobs_org_idx
  on core_queue_jobs(org_id, created_at desc);
