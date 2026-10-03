create table scan_stations (
  id uuid primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
create index scan_stations_org on scan_stations(org_id, user_id);

create table scan_station_sessions (
  id uuid primary key,
  device_id uuid not null references scan_stations(id) on delete cascade,
  state jsonb not null,
  started_at timestamptz not null default now()
);
create index scan_station_sessions_device on scan_station_sessions(device_id, started_at desc);

create table scan_station_requests (
  device_id uuid not null references scan_stations(id) on delete cascade,
  request_id text not null,
  code text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(device_id, request_id)
);

create table scan_tag_aliases (
  org_id uuid not null references orgs(id) on delete cascade,
  uid text not null,
  target jsonb not null,
  primary key(org_id, uid)
);

alter table notifications add column dedupe_key text;
create unique index notifications_dedupe on notifications(org_id, user_id, dedupe_key);
