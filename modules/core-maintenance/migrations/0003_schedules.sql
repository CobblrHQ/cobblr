-- core-maintenance: recurring schedules (#3876).
--
-- A schedule says how often a record wants servicing: by the calendar
-- ("every 3 months"), by a usage counter the record's own kind keeps
-- ("every 200 print hours"), or both, whichever comes first. The entries
-- table stays the service log: a schedule's due occurrence is a scheduled
-- entry carrying schedule_id, and logging the service rolls the schedule
-- forward from when the work was done.
--
-- Additive only: a new table and a nullable column.

create table if not exists core_maintenance_schedules (
  id                 uuid primary key default gen_random_uuid(),
  entity_module      text not null,
  entity_type        text not null,
  entity_id          uuid not null,
  name               text not null,
  every_n            integer,
  every_unit         text,
  counter_field      text,
  counter_every      numeric,
  last_done_at       timestamptz,
  -- The counter reading when it was last done, or when the schedule was set.
  last_done_counter  numeric,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint core_maintenance_schedule_unit
    check (every_unit is null or every_unit in ('day', 'week', 'month', 'year')),
  constraint core_maintenance_schedule_has_a_rule
    check ((every_n is not null and every_n > 0 and every_unit is not null)
        or (counter_field is not null and counter_every is not null and counter_every > 0))
);

create index if not exists core_maintenance_schedules_entity_idx
  on core_maintenance_schedules (entity_module, entity_type, entity_id);

alter table core_maintenance_entries
  add column if not exists schedule_id uuid;

create index if not exists core_maintenance_entries_schedule_idx
  on core_maintenance_entries (schedule_id)
  where schedule_id is not null;
