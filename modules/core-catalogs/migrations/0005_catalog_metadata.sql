-- A catalog keeps the fields a bundle or a person adds to catalogs (on
-- /fields), shown and edited on its page. Additive: one jsonb column
-- defaulting to an empty object.

alter table core_catalogs_catalogs add column if not exists metadata jsonb not null default '{}'::jsonb;
