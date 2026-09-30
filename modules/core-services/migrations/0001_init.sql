-- Services: the jobs (docs/design-decisions/services.md §10).
--
-- One row per call of a capability, in the workspace's own database: a job is
-- workspace data, backed up with it, and what a Make points at. The kernel
-- (api/src/platform/services.ts) writes and polls these rows; this module only
-- owns their schema, the same way core-placement owns placement's table.
--
-- Files are rows, not an array, so "which jobs used this file" is a query.

create table core_services_jobs (
  id                 uuid primary key default gen_random_uuid(),
  capability         text not null,
  capability_version integer not null default 1,
  -- The service connection it runs on (a user_credentials id in the meta DB),
  -- or the built-in that runs it. Exactly one is set once the job is routed.
  connection_id      text,
  built_in           text,
  -- The caller named this connection: a busy one never hands the job on.
  pinned             boolean not null default false,
  remote_job_id      text,
  status             text not null
                     check (status in ('awaiting_confirm', 'queued', 'running', 'needs_input', 'done', 'failed', 'cancelled')),
  progress           real,
  message            text,
  needs              jsonb,
  input              jsonb not null default '{}'::jsonb,
  output             jsonb,
  error              jsonb,
  -- Which door it came through, stamped by the door (never the caller's word).
  origin             text not null check (origin in ('person', 'cobb', 'mcp', 'wire', 'module')),
  requested_by       uuid,
  confirmed_by       uuid,
  -- What a person was shown when asked to confirm; a confirm refuses when the
  -- job no longer hashes to it.
  confirm_hash       text,
  caused_by_job      uuid references core_services_jobs(id) on delete set null,
  hop                integer not null default 0,
  attach_to          jsonb,
  -- Derived from the connection, capability, input and file hashes, plus the
  -- caller's own key: the same call twice is one job.
  idempotency_key    text not null unique,
  service_version    text,
  manifest_version   text,
  poll_errors        integer not null default 0,
  -- The supervisor's clock: when the job last moved (status, progress or
  -- message changed), when it was judged stalled, and when it must be done by.
  last_progress_at   timestamptz,
  stalled_at         timestamptz,
  deadline_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  finished_at        timestamptz
);

create index core_services_jobs_status_idx on core_services_jobs (status) where status in ('awaiting_confirm', 'queued', 'running', 'needs_input');
create index core_services_jobs_caused_by_idx on core_services_jobs (caused_by_job);

create table core_services_job_files (
  job_id     uuid not null references core_services_jobs(id) on delete cascade,
  -- The manifest's files_in / files_out name ("model", "gcode").
  name       text not null,
  direction  text not null check (direction in ('in', 'out')),
  file_id    text not null,
  sha256     text,
  primary key (job_id, direction, name)
);

create index core_services_job_files_file_idx on core_services_job_files (file_id);
