-- What a tag delete or merge took with it, kept so it can be undone: the tag
-- row, every assignment it had (with their ids, since a merge moves them to
-- the other tag rather than removing them), and the tags that sat inside it.
-- Keyed by the tag's id, so an undo from any door finds it. Additive: a new
-- table nothing else reads.
--
-- manual recovery if this fails partway:
--   DROP TABLE core_tags_deleted;
create table core_tags_deleted (
  id           uuid primary key,
  name         text not null,
  row          jsonb not null,
  assignments  jsonb not null default '[]'::jsonb,
  children     jsonb not null default '[]'::jsonb,
  merged_into  uuid,
  deleted_by   uuid,
  deleted_at   timestamptz not null default now()
);
create index core_tags_deleted_at on core_tags_deleted (deleted_at);
