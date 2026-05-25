-- Add an optional `renderer` to module_field_defs so a field def
-- (whether user-authored, bundle-installed, or module-contributed)
-- can declare how its value is drawn in detail pages + lists. The
-- web UI maps the renderer id to a built-in React component; null
-- means "plain text".
--
-- Mirrors the catalog-side `schema.field_renderers` mapping shipped
-- in core-catalogs. Same fixed set of renderer ids — to extend, add
-- to the FIELD_RENDERERS union in
-- web/src/components/CatalogFieldValue.tsx + the zod enum in
-- core-catalogs + this column's check constraint.

alter table module_field_defs
  add column if not exists renderer text
    check (renderer in ('text','color-hex','image-url','url-link','year','boolean','code'));
