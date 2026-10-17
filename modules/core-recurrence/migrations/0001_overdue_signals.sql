-- The overdue sweep's memory: which step of "this is overdue" each record has
-- already been told, so nobody hears the same step twice (tenant-local, like
-- core_cadence_signals; the tenant database is the workspace).
--
-- One row per (record, tier). `due_on` is the deadline the tier was told for:
-- a record given a new date is a new thing to be late for, so a changed
-- `due_on` is told again; the same one never is. Rows for a record that is
-- done or no longer late are removed by the sweep, so a record that goes
-- overdue a second time starts over at the first tier.

create table core_recurrence_overdue_signals (
  entity_kind   text not null,
  entity_id     uuid not null,
  tier          text not null check (tier in ('due', 'late', 'stale')),
  due_on        date not null,
  last_emitted  timestamptz not null default now(),
  primary key (entity_kind, entity_id, tier)
);
