-- Capture EVERYTHING Bambu gives us, raw, so no field is ever lost and UI can be
-- built on top later:
--   digifab_bambu_status.report  — the latest full live MQTT `print` object per
--                                  printer (temps, AMS, layers, fans, HMS errors,
--                                  lights, wifi, the lot).
--   digifab_bambu_tasks          — the cloud print-history entries (model name,
--                                  cover image, weight, time, status, …), one row
--                                  per cloud task, the full JSON kept verbatim.
alter table digifab_bambu_status add column if not exists report jsonb;

create table if not exists digifab_bambu_tasks (
  connection_id text not null,
  task_id       text not null,
  raw           jsonb not null,
  captured_at   timestamptz not null default now(),
  primary key (connection_id, task_id)
);
