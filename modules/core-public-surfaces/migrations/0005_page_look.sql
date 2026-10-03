-- How a public page looks, and how often its labels are scanned (#4502).
-- Additive.
--
-- show_fields: the fields a record shows, in order (Tier A); null shows
--   every field the visibility allows. Never more than the visibility allows.
-- about, links: a few words and a few addresses shown with every record.
-- skin_html: a custom look (Tier B). It runs in a sandboxed document with no
--   network, and is handed only the record as this page shows it.
-- core_public_surfaces_label_scans: how many times a day strangers opened a
--   record through its label, per page. Counts only: nothing about who.
alter table core_public_surfaces_pages add column if not exists show_fields jsonb;
alter table core_public_surfaces_pages add column if not exists about text;
alter table core_public_surfaces_pages add column if not exists links jsonb not null default '[]'::jsonb;
alter table core_public_surfaces_pages add column if not exists skin_html text;
create table if not exists core_public_surfaces_label_scans (
  page_id uuid not null references core_public_surfaces_pages(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key (page_id, day)
);
