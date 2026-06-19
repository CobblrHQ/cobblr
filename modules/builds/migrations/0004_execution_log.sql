-- builds — shop-floor execution log (manufacturing depth ladder rung 6).
--
-- Routing (rung 5) gave a build ordered operations. This records what actually
-- happened on the floor against each operation: time spent (labor/machine/setup)
-- and quantities produced (good / scrap / rework, with a reason). Both are
-- append-only records — the per-operation rollups (actual minutes, good/scrap
-- totals) are computed from them. Generic: "time + outcome logged against a
-- step", not manufacturing-specific.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS builds_op_qty;
--   DROP TABLE IF EXISTS builds_op_time;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0004_execution_log';

-- Time logged against an operation (one row per logged interval).
create table builds_op_time (
  id           uuid primary key default gen_random_uuid(),
  operation_id uuid not null references builds_operations(id) on delete cascade,
  -- Denormalised for build-level queries without a join through operations.
  build_id     uuid not null references builds_builds(id) on delete cascade,
  kind         text not null default 'labor'
                 check (kind in ('labor', 'machine', 'setup')),
  minutes      numeric not null check (minutes >= 0),
  notes        text,
  logged_by    uuid,
  logged_at    timestamptz not null default now()
);

create index builds_op_time_op_idx on builds_op_time(operation_id);
create index builds_op_time_build_idx on builds_op_time(build_id);

-- Quantities produced at an operation (good / scrap / rework).
create table builds_op_qty (
  id           uuid primary key default gen_random_uuid(),
  operation_id uuid not null references builds_operations(id) on delete cascade,
  build_id     uuid not null references builds_builds(id) on delete cascade,
  kind         text not null
                 check (kind in ('good', 'scrap', 'rework')),
  quantity     numeric not null check (quantity > 0),
  reason       text,
  logged_by    uuid,
  logged_at    timestamptz not null default now()
);

create index builds_op_qty_op_idx on builds_op_qty(operation_id);
create index builds_op_qty_build_idx on builds_op_qty(build_id);
