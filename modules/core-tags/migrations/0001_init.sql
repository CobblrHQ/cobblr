-- core-tags — polymorphic labels across entity kinds. Tenant-scoped.
--
-- Replaces api/src/platform/tags.ts (now removed). The old tags +
-- tag_assignments tables in cobblr_meta were empty when this landed
-- (nothing called the deprecated platform helper), so no data
-- migration is needed. Those old tables get dropped in a later
-- cleanup migration.
--
-- Two tables:
--   core_tags_tags         the tag itself, name unique per workspace
--   core_tags_assignments  (tag, entity) polymorphic join. Same shape
--                          as entity_pairings — source-side identifies
--                          the tagged entity via (module, type, id).

create extension if not exists "pgcrypto";

create table core_tags_tags (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- Case-insensitive uniqueness via a functional index; UI may show
  -- mixed-case "Urgent" but typing "urgent" finds the same row.
  color       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index core_tags_tags_name_ci on core_tags_tags(lower(name));

create table core_tags_assignments (
  id              uuid primary key default gen_random_uuid(),
  tag_id          uuid not null references core_tags_tags(id) on delete cascade,
  -- Polymorphic owner. Same column shape as entity_pairings /
  -- file_attachments so a future resolver can treat these uniformly.
  source_module   text not null,
  source_type     text not null,
  source_id       uuid not null,
  created_at      timestamptz not null default now(),
  unique (tag_id, source_module, source_type, source_id)
);

create index core_tags_assignments_source_idx
  on core_tags_assignments(source_module, source_type, source_id);
create index core_tags_assignments_tag_idx on core_tags_assignments(tag_id);
