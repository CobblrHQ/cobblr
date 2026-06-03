-- Rename the bricklink module to bricklink-connector to match the
-- new cobblrhq/bricklink-connector repo (marketplace v2 split).
-- See docs/history/bricklink-rename.md §4 step 6.
--
-- Three references to update:
--   1. org_modules.module_name — which workspaces have it enabled.
--   2. entity_action_bindings.action_id — none today (bricklink
--      declares no actions) but defensive in case bundles installed
--      with bricklink:* IDs.
--   3. installed_modules.name — populated at boot, but if it was
--      already populated under the old name we update.
--
-- Idempotent — re-running is safe (only updates rows still matching
-- the old name).

update org_modules
set module_name = 'bricklink-connector'
where module_name = 'bricklink';

update entity_action_bindings
set action_id = replace(action_id, 'bricklink:', 'bricklink-connector:')
where action_id like 'bricklink:%';

update installed_modules
set name = 'bricklink-connector'
where name = 'bricklink';

-- module_field_defs.source_module if any bundles installed under
-- the old name.
update module_field_defs
set source_module = 'bricklink-connector'
where source_module = 'bricklink';
