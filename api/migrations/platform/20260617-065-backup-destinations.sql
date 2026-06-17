-- Backup destinations — where a workspace's automatic backups go. Phase C of
-- the Blueprint/Backup/Export feature (docs/architecture/blueprint-backup-export.md
-- §7 Phase C). A destination is a driver (filesystem / google_drive / …) + its
-- config + encrypted credentials + a schedule + a retention count. A platform
-- cron builds a backup and pushes it through the driver on schedule; "Back up
-- now" runs one immediately. Mirrors the FarmConnection shape.
--
-- credentials_enc is AES-GCM (encryptCredentials, per-org key) — same posture as
-- digifab connections / integrations. Never returned to clients.
--
-- manual recovery if this fails partway:
--   drop table if exists backup_destinations;
--   delete from migrations where name = '20260617-065-backup-destinations.sql';

create table backup_destinations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id) on delete cascade,
  driver           text not null,                       -- 'filesystem' | 'google_drive' | …
  label            text not null,
  config           jsonb not null default '{}'::jsonb,  -- driver-specific (path, folder id, …)
  credentials_enc  text not null default '',            -- AES-GCM ciphertext; '' = none
  schedule         text not null default 'off'
                     check (schedule in ('off', 'daily', 'weekly')),
  retention        integer not null default 7,          -- keep N most recent
  enabled          boolean not null default true,
  last_run_at      timestamptz,
  last_status      text,                                -- 'ok' | error message
  next_run_at      timestamptz,                         -- when the cron should next fire
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index backup_destinations_org_idx on backup_destinations (org_id);
create index backup_destinations_due_idx on backup_destinations (next_run_at)
  where enabled and schedule <> 'off';
