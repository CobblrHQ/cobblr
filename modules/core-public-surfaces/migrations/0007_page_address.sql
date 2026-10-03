-- A public page's memorable address, /p/<workspace>/<address> (#4502).
-- Additive. Null: the page has none (the default); it is reached only by its
-- links. Set, it opens through a link of its own (config.named) that shows
-- the page's default visibility, so turning it off ends it like any link.
alter table core_public_surfaces_pages add column if not exists address text;
create unique index if not exists core_public_surfaces_pages_address on core_public_surfaces_pages (address) where address is not null;
