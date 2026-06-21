-- Print-update rules — the "OctoEverywhere experience", made configurable.
--
-- Two layers, decoupled (the user's mental model):
--   digifab_channels      — destinations defined ONCE (a Discord channel = its
--                           webhook, encrypted). Reused by many rules.
--   digifab_print_rules   — map a SCOPE (a printer / a class / all printers) to a
--                           channel + a cadence + a message template. e.g. "every
--                           10% or every 30 min, whichever first, but not more than
--                           once every 5 min → photo + status → #prints".
--   digifab_print_rule_state — per (rule, printer) fire bookkeeping so cadence
--                           thresholds fire once and the cap is enforced across
--                           polls/restarts.
--
-- The engine runs off LIVE TELEMETRY (the pump sees every printer's progress
-- regardless of whether the print was queued in Cobblr or started on the
-- machine), so printer-started prints are covered.

create table if not exists digifab_channels (
  id               uuid primary key default gen_random_uuid(),
  label            text not null,
  kind             text not null default 'discord',   -- 'discord' for now; slack/webhook later
  credentials_enc  text not null,                      -- AES-GCM (the webhook URL), per-org key
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists digifab_print_rules (
  id           uuid primary key default gen_random_uuid(),
  label        text not null,
  -- Scope: which printers this rule covers.
  --   'all'     → every printer (scope_value null)
  --   'printer' → one printer; scope_value = "<connection_id>:<remote_device_id>"
  --   'tag'     → printers carrying a tag; scope_value = tag name  (fast-follow)
  --   'family'  → printers of a family;    scope_value = family    (fast-follow)
  scope_type   text not null default 'all',
  scope_value  text,
  channel_id   uuid not null references digifab_channels(id) on delete cascade,
  -- Which lifecycle events fire: {"started":bool,"progress":bool,"completed":bool,"failed":bool}
  events       jsonb not null default '{"progress":true,"completed":true,"failed":true}'::jsonb,
  -- Stackable progress cadence, OR'd (whichever-comes-first). Array of
  -- {"type":"percent|minutes|layers","every":N}. Empty → lifecycle events only.
  cadence      jsonb not null default '[]'::jsonb,
  -- Floor: never fire this rule more than once per `cap_minutes` (null = no cap).
  cap_minutes  integer,
  -- Message template: {"title":"{{printer}} · Print {{event}}","body":"…{{param}}…",
  --                    "photo":true}. Null fields fall back to the built-in default.
  message      jsonb not null default '{}'::jsonb,
  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists digifab_print_rules_channel_idx on digifab_print_rules(channel_id);

create table if not exists digifab_print_rule_state (
  rule_id       uuid not null references digifab_print_rules(id) on delete cascade,
  serial        text not null,                 -- the printer (remote_device_id)
  -- Identifies the current print session, so a new print resets the cadence
  -- baselines (e.g. the file ref + a started-at stamp the pump derives).
  job_key       text,
  last_percent  numeric,                        -- last % we fired at (decile baseline)
  last_layer    integer,
  last_fire_at  timestamptz,                    -- for the cap + the "every N minutes" clock
  primary key (rule_id, serial)
);

-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS digifab_print_rule_state, digifab_print_rules, digifab_channels;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0020_print_rules';
