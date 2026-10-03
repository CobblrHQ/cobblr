create table deleted_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  entity_kind text not null,
  entity_id text not null,
  name text not null,
  instance text,
  deleted_by uuid references users(id) on delete set null,
  deleted_at timestamptz not null default now(),
  restoring boolean not null default false,
  ready boolean not null default false,
  image jsonb not null,
  details jsonb,
  related jsonb not null default '{}'::jsonb,
  unique (org_id, entity_kind, entity_id)
);
create index deleted_records_retention_idx on deleted_records(deleted_at);
create index deleted_records_workspace_idx on deleted_records(org_id, deleted_at desc);
