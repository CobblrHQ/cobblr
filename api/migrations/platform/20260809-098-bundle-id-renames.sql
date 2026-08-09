-- Bundle ids renamed to match the noun they serve (pre-1.0 naming pass).
--
-- A bundle's external_id is IDENTITY: installed workspaces store it in
-- bundles.external_id, and bundle_resource_claims.source uses it to record which
-- bundle owns which instance/field/wire (the refcount behind a clean uninstall).
-- Rename the catalog without rewriting those rows and an installed bundle looks
-- NOT installed: the workspace gets re-offered a bundle it already has (a second
-- install would duplicate instances + fields), upgrade prompts stop firing, and
-- uninstall can no longer find what to remove.
--
-- Doing this now is deliberate: one migration on our own deployments today beats
-- every self-hoster carrying the rename later, after 1.0.
--
-- Idempotent by construction: each UPDATE matches only the OLD literal, so a
-- re-run is a no-op. Renames are id-only; fields, wires and versions are
-- unchanged, so nothing about the workspace's data shape moves.
--
-- Verified against production before writing (read-only): filament-stash was
-- installed in 3 workspaces, vehicle-maintenance and food-cluster in 1 each, so
-- these rows exist in the wild and this is not a theoretical migration.

-- bundles.external_id — the installed-bundle record itself.
update bundles set external_id = 'cobblr.flagship.groceries'  where external_id = 'cobblr.flagship.food-cluster';
update bundles set external_id = 'cobblr.flagship.pets'       where external_id = 'cobblr.flagship.pet-care';
update bundles set external_id = 'cobblr.flagship.plants'     where external_id = 'cobblr.flagship.plant-care';
update bundles set external_id = 'cobblr.flagship.vehicles'   where external_id = 'cobblr.flagship.vehicle-maintenance';
update bundles set external_id = 'cobblr.flagship.documents'  where external_id = 'cobblr.flagship.documents-renewals';
update bundles set external_id = 'cobblr.flagship.warranties' where external_id = 'cobblr.flagship.warranties-receipts';
update bundles set external_id = 'cobblr.flagship.filament'   where external_id = 'cobblr.flagship.filament-stash';
update bundles set external_id = 'cobblr.flagship.grocery-spend' where external_id = 'cobblr.flagship.kitchen-fitness';

-- bundle_resource_claims.source — provenance/refcount for a clean uninstall.
update bundle_resource_claims set source = 'cobblr.flagship.groceries'  where source = 'cobblr.flagship.food-cluster';
update bundle_resource_claims set source = 'cobblr.flagship.pets'       where source = 'cobblr.flagship.pet-care';
update bundle_resource_claims set source = 'cobblr.flagship.plants'     where source = 'cobblr.flagship.plant-care';
update bundle_resource_claims set source = 'cobblr.flagship.vehicles'   where source = 'cobblr.flagship.vehicle-maintenance';
update bundle_resource_claims set source = 'cobblr.flagship.documents'  where source = 'cobblr.flagship.documents-renewals';
update bundle_resource_claims set source = 'cobblr.flagship.warranties' where source = 'cobblr.flagship.warranties-receipts';
update bundle_resource_claims set source = 'cobblr.flagship.filament'   where source = 'cobblr.flagship.filament-stash';
update bundle_resource_claims set source = 'cobblr.flagship.grocery-spend' where source = 'cobblr.flagship.kitchen-fitness';
