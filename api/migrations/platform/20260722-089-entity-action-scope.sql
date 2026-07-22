-- Entity vs workspace scope for a registered action. "entity" (the existing
-- behavior, so the default): the action runs ON a record. "workspace": a
-- config/admin operation that runs on the WORKSPACE itself, with no record —
-- e.g. renaming a label-code prefix, flipping a default. A workspace action
-- skips entity resolution at invoke, never renders as an entity-detail button,
-- and is reached through the SAME invoke_action rail with no entity_kind/id.
-- That is what makes config operations AI-reachable (Cobb / MCP) without a
-- bespoke per-op tool.
--
-- Fully additive + self-healing: registry-sync re-writes every action's scope
-- from its manifest on every boot, so existing rows get their true value on the
-- next boot; the DEFAULT covers the window before that and any action whose
-- manifest omits scope (i.e. entity, the default).
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_actions DROP COLUMN scope;
--   DELETE FROM migrations WHERE name = '20260722-089-entity-action-scope.sql';

alter table entity_actions
  add column scope text not null default 'entity';

comment on column entity_actions.scope is
  'entity = runs on a record (entity button / wire target / invoke_action with an entity); workspace = a config/admin operation with no record, reached through invoke_action with no entity_kind/id. Re-synced from the manifest each boot. See wires-and-bundles.md.';
