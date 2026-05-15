-- Pillar E — module composition. Modules can now declare
-- `dependencies` + a `contributes` block in their manifest;
-- when the module is enabled for an org, its contributed field-defs
-- and wires land in module_field_defs / entity_action_bindings
-- tagged with this `source_module` column.
--
-- Three origins for a field-def or wire:
--   bundle_id set                              → bundle-installed
--   source_module set                          → contributed by a Pillar-E module
--   both null                                  → user-authored via /fields or /wires
--
-- Disabling module B cleans up source_module='B' rows automatically.

alter table module_field_defs
  add column if not exists source_module text;

alter table entity_action_bindings
  add column if not exists source_module text;

create index module_field_defs_source_module_idx
  on module_field_defs(source_module)
  where source_module is not null;
create index entity_action_bindings_source_module_idx
  on entity_action_bindings(source_module)
  where source_module is not null;
