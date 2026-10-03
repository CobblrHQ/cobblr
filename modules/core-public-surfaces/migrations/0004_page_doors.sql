-- A public page's other doors (#4502): its records' printed labels, booth
-- mode, and how a visitor gets in touch. Additive.
--
-- label_door: a signed-out scan of the label on any record this page selects
--   opens that record's public view (the page's own visibility), by the
--   label's long random token only.
-- public_until: booth mode. The page, its links and its labels go private
--   again on their own at this time.
-- contact: an address a visitor can use (a site, or mailto:), shown as a
--   button; a visitor's details are never collected.
-- footer: "Made with Cobblr", on unless turned off.
alter table core_public_surfaces_pages add column if not exists label_door boolean not null default false;
alter table core_public_surfaces_pages add column if not exists public_until timestamptz;
alter table core_public_surfaces_pages add column if not exists contact text;
alter table core_public_surfaces_pages add column if not exists footer boolean not null default true;
