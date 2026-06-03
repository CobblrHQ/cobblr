-- lists — checklist primitive. Tenant-side schema, runs once per org
-- when the module is enabled. Prefixed lists_ per the manifest tablePrefix.
--
-- manual recovery if this fails partway (per-tenant DB; tracked in the tenant's
-- migrations table as `tenant <orgId> / module lists::0001_init.sql`):
--   DROP TABLE IF EXISTS lists_items;
--   DROP TABLE IF EXISTS lists_lists;
--   DELETE FROM migrations WHERE name LIKE '%module lists::0001_init.sql';

create extension if not exists "pgcrypto";

create table lists_lists (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table lists_items (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references lists_lists(id) on delete cascade,
  title       text not null,
  note        text,
  qty         text,
  checked     boolean not null default false,
  checked_at  timestamptz,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index lists_items_list_idx on lists_items(list_id);
-- For the add-item action's dedupe (case-insensitive title within a list).
create index lists_items_dedupe_idx on lists_items(list_id, lower(title));
