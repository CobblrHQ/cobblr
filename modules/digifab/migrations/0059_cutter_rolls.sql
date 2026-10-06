create table digifab_cutter_profiles (
 id uuid primary key default gen_random_uuid(),
 connection_id uuid not null,
 remote_device_id text not null,
 profile jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table digifab_cutter_plans (
 id uuid primary key default gen_random_uuid(),
 connection_id uuid not null,
 remote_device_id text not null,
 library_id uuid not null references digifab_library(id) on delete restrict,
 job_id uuid not null unique references digifab_jobs(id) on delete restrict,
 plan jsonb not null default '{}'::jsonb,
 started_at timestamptz,
 report jsonb,
 consumed_at timestamptz,
 created_at timestamptz not null default now()
);
create table digifab_cutter_roll_claims (
 part_id uuid primary key,
 job_id uuid not null unique references digifab_jobs(id) on delete restrict
);
