-- Per-action arg schema for the wire composer's structured "With" form.
-- `defineModule()`'s action.argsSchema ({ argName: { label, type } }) is synced
-- into this column at boot by registry-sync.ts. Null for actions that declare
-- none — the composer then falls back to a free template. Additive + nullable,
-- so it applies cleanly against existing rows.
alter table entity_actions
  add column args_schema jsonb;

comment on column entity_actions.args_schema is
  'Machine-readable arg shape { name: { label, type } } from the action manifest; null = none. Drives the wire composer''s per-arg fields.';

-- manual recovery if this fails partway:
--   ALTER TABLE entity_actions DROP COLUMN args_schema;
