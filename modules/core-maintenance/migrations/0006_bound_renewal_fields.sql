alter table core_maintenance_schedules
  add column if not exists renewal_fields jsonb,
  add column if not exists cancel_notice_days integer check (cancel_notice_days between 0 and 3650);
