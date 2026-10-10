-- A workspace's own order per job, each step with its model (#5622).
--
-- The AI page showed who answers each job in order, but a step's model could
-- not be changed there: the only per-workspace choice was one connection and
-- model per capability (core_ai_capability_defaults), and every step after it
-- used its connection's default. These are the workspace's steps for a job,
-- the same shape as a person's own (user_ai_job_defaults, #5404): a
-- connection and a model each, First first. A step names a personal
-- connection routed here (credential_id) or one of the workspace's own
-- providers (provider_id alone).
--
-- New and empty: no workspace's calls change until an owner or admin saves an
-- order on the AI page.

create table if not exists core_ai_job_steps (
  job           text not null,
  position      integer not null,
  credential_id text,
  provider_id   text not null,
  model         text not null,
  model_follows text,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  primary key (job, position)
);

comment on table core_ai_job_steps is
  'A workspace''s own order per AI job (AI_JOBS in the contract), each step a connection and model. Read by the router after an exact per-capability pin and before a person''s own defaults.';
comment on column core_ai_job_steps.model_follows is
  'A family''s latest when that was chosen; model then names what it meant when saved.';
