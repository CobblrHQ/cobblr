-- `money` joins the field types: an amount in the workspace currency's main
-- unit, shown and typed through @cobblr/platform-contract/money ("$4,300").
-- Widening a CHECK is additive.
ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_type_check;
ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_type_check
  CHECK (type IN ('text', 'number', 'boolean', 'date', 'url', 'computed', 'relation', 'richtext', 'member', 'person', 'measure', 'money'));
