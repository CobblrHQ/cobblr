-- One row per spreadsheet import, and one row per change it made: everything
-- an undo needs to put the workspace back exactly as it was.
--
-- A spreadsheet import can install a collection, add fields, places and
-- categories, and write hundreds of records, some of them over records that
-- were already there. "That import was wrong" must have an answer that is not
-- a backup restore, so every change is kept here as it is made: what it
-- created (to take away), what a record held before (to put back), and what
-- it looked like straight after (so an undo can tell a thing somebody edited
-- since, and ask instead of overwriting their edit).

create table if not exists core_import_runs (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  created_by_user_id uuid,
  source             text not null default 'spreadsheet',
  filename           text,
  -- queued | running | done | failed | undoing | undone | partly-undone
  status             text not null default 'queued',
  progress_done      integer not null default 0,
  progress_total     integer not null default 0,
  -- Per sheet: where it went and what happened ({ sheets: [...] }).
  summary            jsonb not null default '{}'::jsonb,
  -- The plan being carried out; emptied once the run finishes.
  work               jsonb not null default '{}'::jsonb,
  error              text,
  finished_at        timestamptz,
  undone_at          timestamptz,
  -- What the last undo did, and what it left because somebody changed it since.
  undo_report        jsonb
);

create index if not exists core_import_runs_created_idx
  on core_import_runs (created_at desc);

create table if not exists core_import_run_steps (
  id           bigserial primary key,
  run_id       uuid not null references core_import_runs(id) on delete cascade,
  seq          integer not null,
  -- install | collection | field | location | category | record-create | record-update | tag
  kind         text not null,
  entity_kind  text,
  entity_id    text,
  label        text,
  -- A record's whole row before the import changed it (record-update).
  before       jsonb,
  -- The record's state straight after the import touched it.
  after_hash   text,
  detail       jsonb not null default '{}'::jsonb,
  undone_at    timestamptz
);

create index if not exists core_import_run_steps_run_idx
  on core_import_run_steps (run_id, seq);
