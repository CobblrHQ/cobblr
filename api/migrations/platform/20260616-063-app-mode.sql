-- Managed vertical apps ("Cobblr for Yarn"): an `app_mode` config on a workspace.
-- NULL = a normal platform workspace (the default, every existing row). When set,
-- the workspace is a managed single-purpose app: the web hides all platform chrome
-- (marketplace, bundles, modules, wires, fields, configuration, the workspace
-- switcher) and lands the user straight in the app, so a non-technical user never
-- sees the platform. The blob holds the app id, where to land, and a display label.
-- See business-models/docs/18-managed-vertical-apps.md.
--
-- manual recovery if this fails partway:
--   ALTER TABLE orgs DROP COLUMN app_mode;

alter table orgs add column app_mode jsonb;
