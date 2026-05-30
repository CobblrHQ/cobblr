-- digifab jobs — a print job placed on a farm connection. Tracks the
-- queued → sent → printing → completed/failed lifecycle + the farm's job
-- id, polled by a core-queue worker until terminal.

create table digifab_jobs (
  id                 uuid primary key default gen_random_uuid(),
  connection_id      uuid not null references digifab_connections(id) on delete cascade,
  file_ref           text not null,                   -- filename / slicer output reference
  target_printer     text,                            -- explicit farm printer id, or null
  target_tag         text,                            -- tag name, or null
  farm_file_id       text,                            -- set after upload
  farm_job_id        text,                            -- set after submit (when queued on a printer)
  status             text not null default 'queued',  -- queued|sent|printing|completed|failed|awaiting-assignment|cancelled
  progress           numeric,                         -- 0..1
  error              text,
  linked_machine_id  text,                            -- optional Cobblr machines:machine id
  linked_task_id     text,                            -- optional projects:task id to mark done
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_polled_at     timestamptz
);

create index digifab_jobs_status_idx on digifab_jobs(connection_id, status);
