create table digifab_large_prints (
 job_id uuid primary key references digifab_jobs(id) on delete restrict,
 connection_id uuid not null,
 device_id text not null,
 plan jsonb not null default '{}'::jsonb,
 started_at timestamptz,
 report jsonb,
 consumed_at timestamptz,
 created_at timestamptz not null default now()
);
create index digifab_large_prints_station on digifab_large_prints(connection_id, device_id, created_at);
create table digifab_printer_supplies (
 connection_id uuid not null,
 device_id text not null,
 supply_id text not null,
 reading jsonb not null default '{}'::jsonb,
 low boolean not null default false,
 updated_at timestamptz not null default now(),
 primary key (connection_id, device_id, supply_id)
);
