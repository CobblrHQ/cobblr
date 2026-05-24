-- core-views v1.5 — saved views can be shipped by bundles or by
-- modules' contributes block, same provenance pattern as
-- entity_action_bindings and module_field_defs.
--
-- bundle_id : set when a bundle install created the row. The bundles
--             table lives in cobblr_meta (platform DB), so there's no
--             FK constraint here — cross-DB. Bundle uninstall in
--             api/src/routes/bundles.ts cleans these rows up
--             explicitly (same pattern as entity_action_bindings, but
--             that one's also in cobblr_meta so it gets a real FK).
-- source_module : set when a module's contributes.savedViews installed
--             the row. Cleaned up on module disable.
--
-- Both NULL = user-authored, i.e. it appears in bundle/template
-- exports as the user's own customisation.

alter table core_views_views
  add column bundle_id uuid,
  add column source_module text;

create index core_views_views_bundle_idx
  on core_views_views(bundle_id)
  where bundle_id is not null;

create index core_views_views_source_module_idx
  on core_views_views(source_module)
  where source_module is not null;
