-- A tag keeps the fields a bundle or a person adds to tags (on /fields),
-- shown and edited on its page. Additive: one jsonb column defaulting to an
-- empty object.

alter table core_tags_tags add column if not exists metadata jsonb not null default '{}'::jsonb;
