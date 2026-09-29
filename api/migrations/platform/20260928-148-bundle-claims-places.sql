-- A bundle's claims cover the places it creates (#3918).
--
-- Installing Groceries switched on Lists, Cadence and Views and created
-- Kitchen > Fridge / Freezer / Pantry; uninstalling it left all of that,
-- because the ledger only knew the modules a bundle's own tables live on and
-- the tables themselves. An install now also claims every module it switched
-- on and every place it created (resource_key = the location id), so an
-- uninstall can put back what nothing else claims and nobody has used.
alter table bundle_resource_claims drop constraint if exists bundle_resource_claims_resource_type_check;
alter table bundle_resource_claims add constraint bundle_resource_claims_resource_type_check
  check (resource_type in ('module', 'instance', 'place'));
