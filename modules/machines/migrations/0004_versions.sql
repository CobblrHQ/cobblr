-- What a machine runs: its firmware and its software (the manager or host on
-- it), each with where the value came from (`reported` by its driver, or
-- `typed` by a person) and when it was last seen. `controller` is the firmware
-- family (Klipper, PrusaLink, RepRapFirmware), half of the machine's cohort.
-- A target per cohort says which version the shop wants that cohort on.
-- Nullable, no defaults: existing machines start unknown, which is what they are.
--
-- manual recovery if this fails partway:
--   ALTER TABLE machines_machines DROP COLUMN firmware_version, DROP COLUMN firmware_source, DROP COLUMN firmware_seen_at,
--     DROP COLUMN software_version, DROP COLUMN software_source, DROP COLUMN software_seen_at, DROP COLUMN controller;
--   DROP TABLE machines_version_targets;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0004_versions';
alter table machines_machines add column if not exists firmware_version text;
alter table machines_machines add column if not exists firmware_source text check (firmware_source in ('reported', 'typed'));
alter table machines_machines add column if not exists firmware_seen_at timestamptz;
alter table machines_machines add column if not exists software_version text;
alter table machines_machines add column if not exists software_source text check (software_source in ('reported', 'typed'));
alter table machines_machines add column if not exists software_seen_at timestamptz;
alter table machines_machines add column if not exists controller text;

create table if not exists machines_version_targets (
  id               uuid primary key default gen_random_uuid(),
  instance         text not null,
  cohort           text not null,
  firmware_target  text,
  software_target  text,
  set_by           uuid,
  updated_at       timestamptz not null default now(),
  unique (instance, cohort)
);
