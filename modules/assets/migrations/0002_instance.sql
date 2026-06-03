-- Multi-instance support — see docs/architecture/instances.md.
--
-- The instance column scopes each row to a workspace-defined
-- instance of the module. Default value matches the module name so
-- existing rows belong to the default 'assets' instance + legacy
-- code paths that don't yet know about instances continue to land
-- rows in the default instance. Instance-aware writes explicitly
-- set this column to override the default.

alter table assets_assets
  add column instance text not null default 'assets';

create index assets_assets_instance_idx on assets_assets(instance);
