-- A file keeps the fields a bundle or a person adds to files (on /fields),
-- shown and edited on its page. Additive: one jsonb column defaulting to an
-- empty object.

alter table core_files_files add column if not exists metadata jsonb not null default '{}'::jsonb;
