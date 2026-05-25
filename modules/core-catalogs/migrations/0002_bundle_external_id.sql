-- Catalogs can now be installed via a bundle. When they are, we tag
-- them with the bundle's stable `external_id` (e.g.
-- "rebrickable-lego") so bundle uninstall can find them.
-- Hand-installed catalogs (CSV upload, puller) leave this null.
--
-- We use the bundle's external_id (text) rather than the bundle row's
-- uuid because `bundles` lives in cobblr_meta — we can't FK across
-- databases. External_id is the stable identifier from the manifest
-- and is what the user sees in /bundles.

alter table core_catalogs_catalogs
  add column if not exists bundle_external_id text;

create index if not exists core_catalogs_catalogs_bundle_idx
  on core_catalogs_catalogs(bundle_external_id)
  where bundle_external_id is not null;
