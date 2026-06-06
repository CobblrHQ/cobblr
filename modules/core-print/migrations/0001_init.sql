-- core-print — printer connections (a print MANAGER + a queue on it).
--
-- A row is one reachable printer: a driver (cups | mock), the manager base_url
-- (e.g. http://printhost.lan:631 for CUPS, or an edge-bridge URL), the queue
-- name on that manager, and any auth (encrypted via the platform's per-org
-- credential encryption, same as digifab connections). No live state is kept —
-- coordinate-not-control: we hand the manager a job, we don't mirror the device.
--
-- See docs/modules/core-print.md.

create table core_print_printers (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  driver            text not null default 'cups',  -- 'cups' | 'mock'
  base_url          text not null,                 -- print manager base (IPP host, or bridge URL)
  queue             text not null,                 -- queue / printer name on the manager
  credentials_enc   text,                          -- encrypted { username?, password?, apiKey? }; null = none
  is_default        boolean not null default false,
  notes             text,
  created_by_user_id uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index core_print_printers_default_idx
  on core_print_printers(is_default) where is_default;

-- manual recovery if this fails partway:
--   DROP TABLE core_print_printers;
