-- Rich-text (`richtext`) field type + its `markdown` renderer. A richtext field
-- stores a Markdown string in the entity's metadata jsonb like any text field;
-- the web renders it via react-markdown (block) / stripped (inline). Widen both
-- CHECK constraints on module_field_defs so richtext defs + the markdown renderer
-- can persist. (Was: type set from 20260703-076; renderer set from 20260515-026.)
--
-- Additive: every existing row already satisfies the wider set (a superset), so
-- this applies cleanly with no data change.
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_type_check;
--   ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_type_check
--     CHECK (type IN ('text','number','boolean','date','url','computed','relation'));
--   ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_renderer_check;
--   ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_renderer_check
--     CHECK (renderer IN ('text','color-hex','image-url','url-link','year','boolean','code'));
--   DELETE FROM migrations WHERE name = 'platform::20260705-078-richtext-field-type.sql';

ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_type_check;
ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_type_check
  CHECK (type IN ('text', 'number', 'boolean', 'date', 'url', 'computed', 'relation', 'richtext'));

ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_renderer_check;
ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_renderer_check
  CHECK (renderer IN ('text', 'color-hex', 'image-url', 'url-link', 'year', 'boolean', 'code', 'markdown'));
