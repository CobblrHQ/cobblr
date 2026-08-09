-- Tenant-side half of the bundle-id rename (see
-- api/migrations/platform/20260809-098-bundle-id-renames.sql for the why).
--
-- core_catalogs_catalogs.bundle_external_id records which bundle shipped a
-- catalog, so an id left stale here orphans the catalog from its bundle: the
-- bundle's uninstall no longer claims it, and findByBundleExternalId* lookups
-- miss. Runs per tenant DB, unlike the cobblr_meta half.
--
-- Idempotent: each UPDATE matches only the OLD literal, so a re-run is a no-op.

update core_catalogs_catalogs set bundle_external_id = 'cobblr.flagship.groceries'     where bundle_external_id = 'cobblr.flagship.food-cluster';
update core_catalogs_catalogs set bundle_external_id = 'cobblr.flagship.pets'          where bundle_external_id = 'cobblr.flagship.pet-care';
update core_catalogs_catalogs set bundle_external_id = 'cobblr.flagship.plants'        where bundle_external_id = 'cobblr.flagship.plant-care';
update core_catalogs_catalogs set bundle_external_id = 'cobblr.flagship.vehicles'      where bundle_external_id = 'cobblr.flagship.vehicle-maintenance';
update core_catalogs_catalogs set bundle_external_id = 'cobblr.flagship.documents'     where bundle_external_id = 'cobblr.flagship.documents-renewals';
update core_catalogs_catalogs set bundle_external_id = 'cobblr.flagship.warranties'    where bundle_external_id = 'cobblr.flagship.warranties-receipts';
update core_catalogs_catalogs set bundle_external_id = 'cobblr.flagship.filament'      where bundle_external_id = 'cobblr.flagship.filament-stash';
update core_catalogs_catalogs set bundle_external_id = 'cobblr.flagship.grocery-spend' where bundle_external_id = 'cobblr.flagship.kitchen-fitness';
