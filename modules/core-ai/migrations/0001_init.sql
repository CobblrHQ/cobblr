-- core-ai — per-workspace AI provider config, capability defaults,
-- call audit log, and result cache.
--
-- Credentials live in core_ai_providers.credentials_enc, encrypted
-- with the same per-org AES-GCM master key core-integrations uses.

create extension if not exists "pgcrypto";

create table core_ai_providers (
  id                   uuid primary key default gen_random_uuid(),
  provider_id          text not null,                 -- "openai" / "anthropic" / "ollama" / etc.
  label                text not null,
  credentials_enc      text not null,
  config               jsonb not null default '{}'::jsonb,
  enabled              boolean not null default true,
  monthly_budget_cents integer,                       -- soft cap; warn near, pause at
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index core_ai_providers_pid_idx on core_ai_providers(provider_id);

create table core_ai_capability_defaults (
  capability   text primary key,                       -- "classify-image" / "summarise" / ...
  provider_id  text not null,                          -- references logical id (built-in or row)
  model        text not null,
  config       jsonb not null default '{}'::jsonb,     -- temperature, max_tokens, etc.
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table core_ai_calls (
  id              uuid primary key default gen_random_uuid(),
  provider_id     text not null,
  capability      text not null,
  model           text,
  input_summary   text,
  output_summary  text,
  input_tokens    integer,
  output_tokens   integer,
  cost_cents      integer,
  duration_ms     integer,
  ok              boolean not null,
  error           text,
  source_kind     text,
  source_id       uuid,
  cached          boolean not null default false,
  invoked_at      timestamptz not null default now()
);

create index core_ai_calls_recent_idx on core_ai_calls(invoked_at desc);
create index core_ai_calls_capability_idx on core_ai_calls(capability, invoked_at desc);

create table core_ai_cache (
  cache_key   text primary key,                         -- sha256(capability|provider|model|input)
  capability  text not null,
  result      jsonb not null,
  cost_cents  integer,                                  -- what the cache hit saved
  hit_count   integer not null default 0,
  created_at  timestamptz not null default now(),
  last_hit_at timestamptz
);

create index core_ai_cache_capability_idx on core_ai_cache(capability);
