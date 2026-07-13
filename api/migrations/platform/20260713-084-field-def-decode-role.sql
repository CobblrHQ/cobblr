-- module_field_defs.decode_role — the SEMANTIC decode field-role (P3 of the
-- identifier-decoder registry). A custom field can declare that it either HOLDS
-- a decodable identifier (`identifier:vin`) or is a decode TARGET filled from a
-- decoder's flat output key (`decode:make`, `decode:year`). This lets a decoder
-- target fields by DECLARED ROLE instead of matching English field names, so
-- ISBN/HIN/appliance decoders drop in later with no per-kind code. VIN is the
-- only current consumer. Native fields carry the same role via
-- native_field_overrides.overrides.decode_role (jsonb, no column needed).
--
-- Additive + safe: NULL default applies to every existing row; nothing reads it
-- until a bundle declares a role and the decode-fill planner opts in. See
-- packages/platform-contract parseDecodeRole + docs/design-decisions/vin-decode.md §9.
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP COLUMN IF EXISTS decode_role;
--   DELETE FROM migrations WHERE name = '20260713-084-field-def-decode-role.sql';

alter table module_field_defs
  add column if not exists decode_role text;
