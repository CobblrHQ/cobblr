-- core-maintenance — polymorphic per-entity service log.
--
-- One table, two row kinds:
--   performed_at IS NOT NULL  → "this happened" (history entry)
--   scheduled_at IS NOT NULL  → "this is due"   (upcoming reminder)
-- A row can have both set (something done in the past with a follow-
-- up scheduled, e.g. an oil change with the next one due in 6 months).
--
-- Polymorphic owner: (entity_module, entity_type, entity_id) is a soft
-- reference into another module's tables. No FK — different modules
-- own different tables, and over the long arc may even live in
-- separate DBs. If the target disappears we leave the row dangling.

create extension if not exists "pgcrypto";

create table core_maintenance_entries (
  id              uuid primary key default gen_random_uuid(),
  entity_module   text not null,
  entity_type     text not null,
  entity_id       uuid not null,
  name            text not null,
  description     text,
  performed_at    timestamptz,
  scheduled_at    timestamptz,
  cost_cents      integer,
  performed_by    uuid,                 -- user_id, optional
  notes           text,
  -- recurrence_rule (RRULE) for repeating maintenance — handled by
  -- core-recurrence's scanner; this is opaque to us.
  recurrence_rule text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Sanity: a row must be one or the other (or both, but not neither).
  constraint at_least_one_date
    check (performed_at is not null or scheduled_at is not null)
);

create index core_maintenance_entity_idx
  on core_maintenance_entries (entity_module, entity_type, entity_id);
create index core_maintenance_scheduled_idx
  on core_maintenance_entries (scheduled_at)
  where scheduled_at is not null;
create index core_maintenance_performed_idx
  on core_maintenance_entries (performed_at desc)
  where performed_at is not null;
