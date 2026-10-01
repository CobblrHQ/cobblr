-- `measure` joins the field types: a measured value with an SI prefix
-- ("4k7", "100 nF", "16 V"), stored as { value, unit, text }
-- (@cobblr/platform-contract/measure). Widening a CHECK is additive.
ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_type_check;
ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_type_check
  CHECK (type IN ('text', 'number', 'boolean', 'date', 'url', 'computed', 'relation', 'richtext', 'member', 'person', 'measure'));
