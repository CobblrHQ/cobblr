-- Per-tenant baseline. Runs once on each new tenant DB at provision
-- time. Modules add their own tables via their own migrations folder
-- when the user enables them.
--
-- platform_local is the per-tenant settings bucket — anything that
-- needs to be different per tenant but doesn't belong to a specific
-- module lives here.

create extension if not exists "pgcrypto";

create table platform_local (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

insert into platform_local (key, value) values
  ('schema_version', '"1"'::jsonb),
  ('created_at', to_jsonb(now()));
