-- Relation field type. A field def of type='relation' references another entity
-- kind (e.g. core-locations:location) — the "link to another record" field.
-- `ref_kind` names the referenced kind; the stored VALUE (a target id) lives in
-- the entity's metadata jsonb like any custom field, and the read layer resolves
-- it to the target's title (`<name>_label`) for display.
--
-- Additive + nullable, so it applies cleanly to every existing row (null =
-- not a relation field — every existing def).
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP COLUMN ref_kind;
--   (and restore the prior type check: drop constraint, re-add with the
--    pre-'relation' set)
--   DELETE FROM migrations WHERE name = 'platform::20260703-076-field-def-ref-kind.sql';

ALTER TABLE module_field_defs
  ADD COLUMN ref_kind text;

-- Widen the type CHECK to admit 'relation' (was …/url/computed — see
-- 20260603-038-computed-field-defs.sql).
ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_type_check;
ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_type_check
  CHECK (type IN ('text', 'number', 'boolean', 'date', 'url', 'computed', 'relation'));
