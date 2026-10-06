alter table core_maintenance_entries
  add column if not exists is_term boolean not null default false,
  add column if not exists term_start timestamptz,
  add column if not exists term_end timestamptz,
  add column if not exists currency text,
  add column if not exists reference text,
  add column if not exists quantity numeric,
  add column if not exists previous_term_id uuid references core_maintenance_entries(id) on delete set null,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table core_maintenance_entries add constraint core_maintenance_term_dates
  check (term_start is null or term_end is null or term_end > term_start);
alter table core_maintenance_entries add constraint core_maintenance_term_quantity
  check (quantity is null or quantity > 0);
create index if not exists core_maintenance_terms_chain
  on core_maintenance_entries (schedule_id, term_end desc) where is_term;
alter table core_maintenance_schedules
  add column if not exists ended_at timestamptz,
  add column if not exists ended_by uuid;
