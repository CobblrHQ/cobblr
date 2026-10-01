-- The supervisor (services.md S9): which attempt of a job is the live one.
--
-- A stalled job handed on to the next service, or retried by a person, is the
-- same row with its attempt raised. Every write the poller makes is bound to
-- the attempt it started with, so an answer that arrives late from the service
-- it left (or a built-in that finally returns) changes nothing. Additive.
alter table core_services_jobs add column if not exists attempt integer not null default 0;

-- A person's Retry is a new job, never a finished one reopened (nothing
-- leaves a terminal state): the new row names the one it retries, so the Run
-- view shows both as one step. A Skip leaves the failed row as it was and
-- says who skipped it; the run goes on without its output.
alter table core_services_jobs add column if not exists retry_of uuid references core_services_jobs(id) on delete set null;
alter table core_services_jobs add column if not exists skipped_by uuid;
alter table core_services_jobs add column if not exists skipped_at timestamptz;
create index if not exists core_services_jobs_retry_of_idx on core_services_jobs (retry_of) where retry_of is not null;
