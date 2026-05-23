-- D3 from docs/BACKLOG.md: per-entity recurrence state.
--
-- Per-(org, kind, entity) last-fired bookkeeping. Modules register
-- recurrence scanners via platform().recurrence.registerScanner(kind,
-- fn) at boot — they return [{entityId, rrule, event, title?}] per
-- tenant. core-recurrence's scheduler reads from those scanners and
-- writes to this table to track last-fired times.
--
-- Lives in cobblr_meta (the scheduler is cross-tenant; idempotency
-- needs cross-tenant state).

create table core_recurrence_entity_state (
  org_id          uuid not null references orgs(id) on delete cascade,
  kind            text not null,
  entity_id       uuid not null,
  last_fired_at   timestamptz not null,
  next_due_at     timestamptz,
  primary key (org_id, kind, entity_id)
);

create index core_recurrence_entity_state_kind_idx
  on core_recurrence_entity_state(kind, last_fired_at desc);
