create table digifab_laser_profiles (
 id uuid primary key default gen_random_uuid(),
 connection_id uuid not null,
 remote_device_id text not null,
 profile jsonb not null default '{}'::jsonb,
 source jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table digifab_laser_plans (
 id uuid primary key default gen_random_uuid(),
 connection_id uuid not null,
 remote_device_id text not null,
 library_id uuid not null references digifab_library(id) on delete restrict,
 plan jsonb not null default '{}'::jsonb,
 run_id uuid references digifab_production_runs(id) on delete set null,
 created_at timestamptz not null default now()
);
create table digifab_laser_sheet_claims (
 part_id text primary key,
 plan_id uuid not null references digifab_laser_plans(id) on delete cascade
);
alter table digifab_production_runs add column laser_plan_id uuid references digifab_laser_plans(id) on delete restrict;
alter table digifab_jobs add column laser_layout jsonb;
