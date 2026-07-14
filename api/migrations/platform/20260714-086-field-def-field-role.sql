-- module_field_defs.field_role — a field's SEMANTIC role in the record, distinct
-- from `decode_role` (which is about identifier decoding) and from the manifest's
-- presentation `role` (title/subtitle/image/quantity/unit — how to DISPLAY it).
--
-- The first consumer is `category`: the field that says what KIND of thing this
-- record is, WITHIN its table. The scan matchmaker needs this axis because
-- without it, the only way it can express "this is an electrical part, that is a
-- plumbing part" is to route them to DIFFERENT TABLES — which is exactly what it
-- did, scattering five electrical parts across four near-synonym tables (Home
-- Inventory / Household Supplies / Inventory / Maker Workshop). A difference in
-- kind is a category, not a different table.
--
-- Declared, never guessed — the same rule decode_role established: a consumer
-- targets a field by its DECLARED role, never by matching English names. So this
-- works for any module or bundle, and the kernel never learns the word
-- "Electrical". Native fields carry the same role via
-- native_field_overrides.overrides.field_role (jsonb, no column needed).
--
-- Additive + safe: NULL default applies to every existing row; nothing reads it
-- until a field declares a role.
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP COLUMN IF EXISTS field_role;
--   DELETE FROM migrations WHERE name = '20260714-086-field-def-field-role.sql';

alter table module_field_defs
  add column if not exists field_role text;

-- At most ONE category field per entity kind per org — an ambiguous grouping axis
-- is worse than none (the matchmaker would have to guess which one it meant).
create unique index if not exists module_field_defs_one_category_per_kind
  on module_field_defs(org_id, entity_kind)
  where field_role = 'category';
