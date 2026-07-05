-- knowledge — Knowledge Base entries. Tenant-side schema, runs once per org
-- when the module is enabled. Prefixed knowledge_ per the manifest tablePrefix.
-- The module's OWN fields are columns (title/body/kind/pinned/code); user-added
-- custom fields live in metadata jsonb like every other module.
--
-- manual recovery if this fails partway (per-tenant DB; tracked in the tenant's
-- migrations table as `tenant <orgId> / module knowledge::0001_init.sql`):
--   DROP TABLE IF EXISTS knowledge_entries;
--   DELETE FROM migrations WHERE name LIKE '%module knowledge::0001_init.sql';

create extension if not exists "pgcrypto";

create table knowledge_entries (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text,                                  -- Markdown (richtext field)
  kind        text,                                  -- in-vault category
  pinned      boolean not null default false,        -- surfaced in Quick Access
  code        text,                                  -- owned code → barcode renderer
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Quick Access reads pinned entries; a partial index keeps that lookup cheap.
create index knowledge_entries_pinned_idx on knowledge_entries(pinned) where pinned = true;
create index knowledge_entries_kind_idx on knowledge_entries(kind);
