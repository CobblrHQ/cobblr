-- Who can find a public page, and the colour it wears (#4502). Additive.
--
-- indexable: off, every page and record of it tells search engines not to
--   list it (noindex). On, it may be listed. Off by default: a page is for
--   whoever holds its link.
-- accent: the page's own accent colour over the workspace's brand; null
--   wears the brand as it is.
alter table core_public_surfaces_pages add column if not exists indexable boolean not null default false;
alter table core_public_surfaces_pages add column if not exists accent text;
