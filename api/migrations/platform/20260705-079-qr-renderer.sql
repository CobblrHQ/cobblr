-- `qr` field renderer — renders a text value as a scannable QR (owned codes:
-- a UPC, a location/asset tag, a URL). Widen the renderer CHECK on
-- module_field_defs so a field-def can persist renderer='qr'. (Was: the set
-- from 20260705-078, which added 'markdown'.)
--
-- Additive: every existing row already satisfies the wider set. Note this is a
-- code-GENERATING renderer — correct only for values you own; a scanner's CONFIG
-- barcodes are exact Code-128 and must be stored as an image, never regenerated.
--
-- manual recovery if this fails partway:
--   ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_renderer_check;
--   ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_renderer_check
--     CHECK (renderer IN ('text','color-hex','image-url','url-link','year','boolean','code','markdown'));
--   DELETE FROM migrations WHERE name = 'platform::20260705-079-qr-renderer.sql';

ALTER TABLE module_field_defs DROP CONSTRAINT IF EXISTS module_field_defs_renderer_check;
ALTER TABLE module_field_defs ADD CONSTRAINT module_field_defs_renderer_check
  CHECK (renderer IN ('text', 'color-hex', 'image-url', 'url-link', 'year', 'boolean', 'code', 'markdown', 'qr'));
