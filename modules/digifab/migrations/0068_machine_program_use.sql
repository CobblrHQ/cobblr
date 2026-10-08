alter table digifab_jobs add column cnc_setup jsonb;
alter table digifab_jobs add column cnc_tool_seconds jsonb not null default '{}'::jsonb;
alter table digifab_jobs add column cnc_usage_report jsonb;
alter table digifab_jobs add column cnc_usage_recorded_at timestamptz;
alter table digifab_laser_sheet_claims alter column plan_id drop not null;
alter table digifab_laser_sheet_claims add column job_id uuid references digifab_jobs(id) on delete restrict;
