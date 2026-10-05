alter table core_maintenance_schedules
  add column if not exists anchor jsonb,
  add column if not exists remind jsonb,
  add column if not exists expiry_field text,
  add column if not exists current_expiry timestamptz;

create unique index if not exists core_maintenance_one_expiry_field
  on core_maintenance_schedules (entity_id, expiry_field)
  where expiry_field is not null;

 alter table core_maintenance_schedules add column if not exists overdue_every text check (overdue_every in ('day', 'week', 'month', 'off'));
 alter table core_maintenance_entries
   add column if not exists nag_snoozed_until timestamptz,
   add column if not exists nag_stopped_at timestamptz;
 create table if not exists core_maintenance_preferences (
   id boolean primary key default true check (id),
   overdue_every text not null default 'week' check (overdue_every in ('day', 'week', 'month', 'off'))
 );
