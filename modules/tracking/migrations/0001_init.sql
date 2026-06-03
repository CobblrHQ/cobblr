-- tracking — log/goal/trend primitive. Tenant schema, runs on enable.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS tracking_measurements;
--   DROP TABLE IF EXISTS tracking_metrics;
--   DELETE FROM migrations WHERE name LIKE '%module tracking::0001_init.sql';

create extension if not exists "pgcrypto";

create table tracking_metrics (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  unit           text,
  goal_value     numeric,
  -- which way is "good": 'down' (lose weight), 'up' (more reps), 'hit' (be at target)
  goal_direction text not null default 'hit',
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table tracking_measurements (
  id          uuid primary key default gen_random_uuid(),
  metric_id   uuid not null references tracking_metrics(id) on delete cascade,
  value       numeric not null,
  measured_at timestamptz not null default now(),
  note        text,
  created_at  timestamptz not null default now()
);

create index tracking_meas_metric_time_idx on tracking_measurements(metric_id, measured_at desc);
