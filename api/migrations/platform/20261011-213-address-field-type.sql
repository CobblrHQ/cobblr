-- `address` joins the field types: where an appointment or a visit happens,
-- stored as { name, street, city, region, postal, country, line, lat?, lon?,
-- source } and read through @cobblr/platform-contract/address (#5317).
-- Widening a CHECK is additive.
ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_type_check;
ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_type_check
  CHECK (type IN ('text', 'number', 'boolean', 'date', 'url', 'computed', 'relation', 'richtext', 'member', 'person', 'measure', 'money', 'secret', 'address'));
