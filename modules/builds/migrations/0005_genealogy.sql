-- builds — genealogy / traceability (manufacturing depth ladder rung 8).
--
-- A build RUN is the transformation (the "activity"). These two tables are its
-- directed edges: which input lots were consumed, and what output (with an
-- optional serial/lot) was produced. Linking an input's lot_code to a prior
-- run's output serial_code forms the as-built lineage graph — "what went into
-- serial #X" (backward / recall) and "where did lot Y go" (forward). Carbon's
-- tracked-entity + tracked-activity model, scoped to what builds can own without
-- forcing inventory-wide lot tracking.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS builds_run_inputs;
--   DROP TABLE IF EXISTS builds_run_outputs;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0005_genealogy';

-- What a run produced (anchors the run in the lineage graph).
create table builds_run_outputs (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references builds_runs(id) on delete cascade,
  -- The output inventory part, if the build produces one (soft ref, nullable).
  part_id     uuid,
  -- User-entered serial / lot for this output unit (nullable — not every build
  -- is serialised). The handle a later run references as an input lot_code.
  serial_code text,
  quantity    numeric not null default 1,
  created_at  timestamptz not null default now()
);

create index builds_run_outputs_run_idx on builds_run_outputs(run_id);
create index builds_run_outputs_serial_idx on builds_run_outputs(serial_code) where serial_code is not null;

-- What a run consumed (one row per leaf input).
create table builds_run_inputs (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references builds_runs(id) on delete cascade,
  -- The consumed inventory part (soft ref — cross-module, no FK).
  part_id     uuid not null,
  -- Which incoming lot/serial was consumed (nullable). When it matches a prior
  -- run's output serial_code, that prior run becomes a child in the as-built tree.
  lot_code    text,
  quantity    numeric not null default 0,
  created_at  timestamptz not null default now()
);

create index builds_run_inputs_run_idx on builds_run_inputs(run_id);
create index builds_run_inputs_lot_idx on builds_run_inputs(lot_code) where lot_code is not null;
