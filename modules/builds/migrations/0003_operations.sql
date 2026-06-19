-- builds — routing / operations (the ordered STEPS to make a build).
--
-- A build had a bill-of-materials (what it's made of) but no routing (the ordered
-- steps to make it). builds_operations is that ordered list: seq, name, status,
-- an optional time estimate, and an optional polymorphic resource the step runs
-- on (e.g. machines:machine) — soft ref, cross-module, no FK. Generic: an
-- "operation" is just an ordered step to make the thing (assembly step, cook
-- step, …), not manufacturing-specific.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS builds_operations;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0003_operations';

create table builds_operations (
  id          uuid primary key default gen_random_uuid(),
  build_id    uuid not null references builds_builds(id) on delete cascade,
  -- Order within the build's routing (1, 2, 3, …).
  seq         integer not null default 0,
  name        text not null,
  description text,
  status      text not null default 'todo'
                check (status in ('todo', 'doing', 'done', 'skipped')),
  -- Optional estimated minutes for this step.
  est_minutes numeric,
  -- Optional resource this step runs on — polymorphic soft ref (e.g.
  -- machines:machine). All three set together or all null. No FK (cross-module).
  resource_module text,
  resource_type   text,
  resource_id     text,
  notes       text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (
    (resource_module is null and resource_type is null and resource_id is null)
    or (resource_module is not null and resource_type is not null and resource_id is not null)
  )
);

create index builds_operations_build_idx on builds_operations(build_id, seq);
