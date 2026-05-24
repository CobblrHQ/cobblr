-- core-integrations — outbound + inbound external connectors.
--
-- Per-workspace tables:
--   connectors        — installed connections (Slack webhook URL,
--                       Stripe signing secret, etc.). Credentials
--                       encrypted with a per-org key in cobblr_meta.
--   inbound_tokens    — workspace's inbound URL tokens; one per
--                       (workspace, connector) by default.
--   calls             — per-call audit log, retention-swept on read.

create extension if not exists "pgcrypto";

create table core_integrations_connectors (
  id                 uuid primary key default gen_random_uuid(),
  connector_id       text not null,           -- "slack" / "discord" / "webhook" / "email" / "stripe" / etc.
  label              text not null,
  credentials_enc    text not null,           -- AES-GCM ciphertext
  config             jsonb not null default '{}'::jsonb,
  enabled            boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index core_integrations_connectors_id_idx
  on core_integrations_connectors(connector_id);

create table core_integrations_inbound_tokens (
  id           uuid primary key default gen_random_uuid(),
  connector_id text not null,
  token        text not null,                 -- The URL-embedded secret
  label        text not null,
  config       jsonb not null default '{}'::jsonb,
  enabled      boolean not null default true,
  last_hit_at  timestamptz,
  hit_count    integer not null default 0,
  created_at   timestamptz not null default now()
);

create unique index core_integrations_inbound_tokens_token_idx
  on core_integrations_inbound_tokens(token);

create table core_integrations_calls (
  id              uuid primary key default gen_random_uuid(),
  direction       text not null check (direction in ('outbound', 'inbound')),
  connector_id    text not null,
  action_or_event text not null,
  status          integer,
  ok              boolean not null,
  error           text,
  request_meta    jsonb,
  ms              integer,
  occurred_at     timestamptz not null default now()
);

create index core_integrations_calls_recent_idx
  on core_integrations_calls(occurred_at desc);
