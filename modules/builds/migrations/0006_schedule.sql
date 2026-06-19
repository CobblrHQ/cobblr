-- builds — planned production + scheduling (manufacturing depth ladder rung 7).
--
-- A planned build is something you INTEND to make (build + qty + due date +
-- optional lane). The scheduler is a deliberate **heuristic**, not a finite-
-- capacity solver: earliest-due-date (EDD) dispatch, laid out sequentially per
-- lane (resource_label), flagging items projected to finish after their due
-- date. It does NOT solve cross-resource capacity, setup sequencing, or
-- splitting — that's the honest boundary (see business-models/docs/22, rung 7).
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS builds_planned;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0006_schedule';

create table builds_planned (
  id             uuid primary key default gen_random_uuid(),
  build_id       uuid not null references builds_builds(id) on delete cascade,
  qty            numeric not null default 1 check (qty > 0),
  due_date       date,
  -- Higher first within a lane when due dates tie.
  priority       integer not null default 0,
  -- The lane this is scheduled in (a work centre / station / person). Free text —
  -- null lands in the "Unassigned" lane.
  resource_label text,
  status         text not null default 'planned'
                   check (status in ('planned', 'done', 'cancelled')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index builds_planned_build_idx on builds_planned(build_id);
create index builds_planned_status_idx on builds_planned(status);
create index builds_planned_lane_idx on builds_planned(resource_label);
