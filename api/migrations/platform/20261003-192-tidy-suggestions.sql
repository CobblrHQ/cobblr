alter table orgs add column if not exists tidy_enabled boolean not null default false;
alter table orgs add column if not exists tidy_last_run timestamptz;
alter table orgs add column if not exists tidy_shape_version integer;
create table if not exists tidy_suggestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  candidate jsonb not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists tidy_suggestions_waiting on tidy_suggestions(org_id) where decided_at is null;
create table if not exists tidy_suppressions (
  org_id uuid not null references orgs(id) on delete cascade,
  kind text not null,
  record_kind text not null,
  record_id text not null,
  until_at timestamptz,
  primary key(org_id, kind, record_kind, record_id)
);
create table if not exists tidy_route_cache (
  org_id uuid not null references orgs(id) on delete cascade,
  record_key text not null,
  fingerprint text not null,
  result jsonb,
  primary key(org_id, record_key)
);
