-- module_field_defs.fact_scope: whether a field is a fact about the MODEL
-- ("model": every unit of it shares it, a 3D printer's bed size) or about
-- this one UNIT ("instance": its seller, serial, price, what was upgraded on
-- it) (#6013).
--
-- Declared, like field_role: a bundle says it, and the platform reads it
-- through one rule (@cobblr/platform-contract/fact-scope). A field that
-- declares none is read from its role, type and name, the rule the barcode
-- network has used since #5804, so nothing that worked changes.
--
-- Additive + safe: NULL for every existing row means "not declared".
-- A bundle's declaration reaches an existing install through the bundle
-- field reconcile (api/src/platform/bundle-field-roles.ts).
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP COLUMN IF EXISTS fact_scope;
--   DELETE FROM migrations WHERE name = '20261012-216-field-def-fact-scope.sql';

alter table module_field_defs
  add column if not exists fact_scope text;
