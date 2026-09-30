-- Makes (services.md §13): one fabrication run from the request to the
-- outcome, every step kept with what produced it and the files it made.
--
-- A job is one send to one printer; a Make can have no print (design only),
-- start from a file a person brought, or be a re-run of another from any
-- step. So it is its own record, and the job becomes its Print step's pointer.
-- Additive only: two new tables, nothing existing changes.

create table if not exists digifab_makes (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(btrim(name)) between 1 and 200),
  -- The words that started it, when a request did (the Request step keeps
  -- the full record; this copy is what search reads).
  prompt           text,
  -- The first step this Make has. Earlier ones are absent, never faked: a
  -- Make started from your own STL begins at `model`.
  start_step       text not null default 'request'
                   check (start_step in ('request', 'design', 'model', 'slice', 'print')),
  -- A re-run: the Make it came from and the step it ran again from.
  rerun_of         uuid references digifab_makes(id) on delete set null,
  rerun_from_step  text check (rerun_from_step in ('design', 'model', 'slice', 'print', 'outcome')),
  -- The core-files folder its files live in.
  folder_id        text,
  -- Search copies, written as the steps are recorded: the printer's name and
  -- the material, and the outcome once there is one.
  printer_name     text,
  material         text,
  outcome          text check (outcome in ('pass', 'fail')),
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists digifab_makes_created_idx on digifab_makes (created_at desc);
create index if not exists digifab_makes_rerun_idx on digifab_makes (rerun_of) where rerun_of is not null;

-- One row per step reached. A Make has at most one of each; running a step
-- again is a new Make (rerun_of), so the first one's history never changes.
create table if not exists digifab_make_steps (
  id               uuid primary key default gen_random_uuid(),
  make_id          uuid not null references digifab_makes(id) on delete cascade,
  step             text not null check (step in ('request', 'design', 'model', 'slice', 'print', 'outcome')),
  -- running | needs_input | awaiting_confirm | done | failed
  status           text not null default 'done'
                   check (status in ('running', 'needs_input', 'awaiting_confirm', 'done', 'failed')),
  -- What the step holds: the prompt, the source and parameters, the report,
  -- the slicer's settings snapshot, grams per tool, the verdict. Its shape
  -- per step is in makes-core.ts.
  data             jsonb not null default '{}'::jsonb,
  -- What produced it: {kind: "person"|"service"|"upload"|"digifab", name,
  -- version, capability}. A person's upload is a producer too.
  produced_by      jsonb not null default '{}'::jsonb,
  -- The service job behind it, when one was (read through
  -- platform().services.job; the job lives with the services module).
  service_job_id   text,
  -- The digifab job behind the Print step.
  job_id           uuid references digifab_jobs(id) on delete set null,
  error            text,
  -- Copied forward from the Make this one re-ran, not done again.
  copied_from      uuid references digifab_make_steps(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (make_id, step)
);

create index if not exists digifab_make_steps_job_idx on digifab_make_steps (job_id) where job_id is not null;
