-- labels 0.7.2 - accumulate-then-print auto-flush policy (per user, dormant backend).
--
-- A per-user auto-flush binding: which printer + label size the print queue
-- auto-fires to, and the fire rule (manual | fill-media | count | immediate). The
-- queue-insert handler evaluates flush-policy.ts against this on each add; a
-- non-manual policy renders the due labels and enqueues a background dispatch to
-- core-print. last_fired_at backs the runaway cooldown. See
-- docs/design-decisions/label-media-and-accumulation.md (slice 2, D5/D6/D9).
--
-- Tenant-local: no org_id, the tenant DB is the org. Additive; default OFF, so
-- existing workspaces keep their manual print behaviour until a user turns it on.

create table if not exists labels_autoflush (
  user_id        text primary key,
  enabled        boolean not null default false,
  -- A core-print printer id. Cross-module reference (no FK: core-print owns its
  -- table); a deleted printer is handled at dispatch time (the job drops).
  printer_id     text,
  -- The label size to render: a built-in key or `custom:<uuid>`.
  size_key       text,
  fire_mode      text not null default 'manual'
                   check (fire_mode in ('manual','fill-media','count','immediate')),
  fire_count     integer not null default 2 check (fire_count >= 1),
  -- Last time this policy fired a print, for the runaway cooldown.
  last_fired_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
