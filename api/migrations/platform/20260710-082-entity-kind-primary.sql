-- The module's PRIMARY kind: the entity its instance-scoped item routes
-- (/instances/:name/items) dispatch to, declared `primary: true` in the kind
-- manifest and synced by registry-sync. Instance-kind synthesis in
-- /entity-kinds copies the primary kind's shape (fields/traits/endpoints)
-- for each of a workspace's named instances.
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_kinds DROP COLUMN is_primary;
alter table entity_kinds
  add column if not exists is_primary boolean not null default false;
