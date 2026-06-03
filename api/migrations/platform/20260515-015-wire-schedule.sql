-- Phase 6: schedule as a third wire trigger type.
--
-- Q4 from docs/architecture/wires-and-bundles.md. The
-- core-recurrence stock module evaluates RRULE strings and calls
-- fireEvent() directly when a schedule matches; this migration adds
-- the schema bits so wires can declare a schedule.
--
-- The trigger_type column is text with a CHECK constraint (not a
-- pg enum) — see migration 003. Drop and replace the constraint
-- with the new allowlist that includes 'schedule'.
--
-- See:
--   docs/architecture/wires-and-bundles.md — Q4 resolution
--   modules/core-recurrence/ — owns the cron-like firing loop

-- Find the existing CHECK constraint by its target column + look-
-- alike text so we can drop it cleanly.
alter table entity_action_bindings
  drop constraint entity_action_bindings_trigger_type_check;

alter table entity_action_bindings
  add constraint entity_action_bindings_trigger_type_check
    check (trigger_type in (
      'user-invoked',
      'event',
      'on-create',
      'on-update',
      'on-delete',
      'schedule'
    ));

-- Per-wire RRULE (iCal-style, e.g. 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9').
-- Null for any non-schedule wire.
alter table entity_action_bindings
  add column trigger_schedule text;

comment on column entity_action_bindings.trigger_schedule is
  'RRULE string for schedule-triggered wires (Q4). Null for event / user-invoked / on-* triggers. See docs/architecture/wires-and-bundles.md.';

-- Idempotency state for the core-recurrence scheduler — one row per
-- wire, tracking last-fired-at so a process restart doesn't double-
-- fire the same occurrence. Lives at the platform layer (not the
-- module's table prefix) because the wire engine reads it during
-- fireEvent; the module is the writer.
create table if not exists wire_schedule_state (
  binding_id uuid primary key references entity_action_bindings(id) on delete cascade,
  last_fired_at timestamptz,
  next_due_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists ix_wire_schedule_state_next
  on wire_schedule_state(next_due_at)
  where next_due_at is not null;

comment on table wire_schedule_state is
  'Per-wire scheduling state owned by core-recurrence. last_fired_at + next_due_at let the scheduler skip already-fired occurrences across restarts.';
