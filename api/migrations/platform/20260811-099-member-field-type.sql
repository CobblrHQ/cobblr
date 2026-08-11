-- `member` (a person) joins the field types. Widening a CHECK is additive: an
-- older api that does not know the type simply never writes it.
--
-- This constraint is the EIGHTH place the field-type list is written, and the
-- only one in SQL. The other seven were unified behind FIELD_TYPE_VALUES, but a
-- TypeScript lint cannot see a Postgres constraint, so `member` passed zod
-- validation and was rejected by the database — a feature that typechecked,
-- linted, unit-tested and shipped without working. lint:field-type-sql now
-- compares this list against FIELD_TYPE_VALUES so the next type cannot repeat it.

ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_type_check;
ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_type_check
  CHECK (type IN ('text', 'number', 'boolean', 'date', 'url', 'computed', 'relation', 'richtext', 'member'));
