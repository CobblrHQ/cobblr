-- What a place delete took with it, kept so the delete can be undone: the
-- place, every place inside it, and where each thing kept in them was. The
-- row is keyed by the deleted place's id, so an undo of that place (the
-- page's Undo, or the assistant's, which restores the one row it knew about)
-- finds everything that went with it. Additive: a new table nothing else reads.
--
-- manual recovery if this fails partway:
--   DROP TABLE core_locations_deleted;
create table core_locations_deleted (
  id          uuid primary key,
  name        text not null,
  rows        jsonb not null,
  placements  jsonb not null default '[]'::jsonb,
  deleted_by  uuid,
  deleted_at  timestamptz not null default now()
);
create index core_locations_deleted_at on core_locations_deleted (deleted_at);
