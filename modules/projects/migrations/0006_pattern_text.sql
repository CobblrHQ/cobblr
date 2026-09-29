-- A pattern's words, kept so search can find a pattern by what is in it.
--
-- The materials reader (#3791) extracts a pattern PDF's text the moment the
-- PDF lands, reads the yarn and hooks out of it, and threw the rest away. So
-- a search for "amigurumi", "worsted" or "magic ring" found nothing unless the
-- pattern's name said it. One row per pattern: the text of its latest pattern
-- PDF, with the file it came from. A separate table, so every list of
-- projects does not carry whole PDFs.
--
-- `pending` marks a pattern made before this existed, whose PDF (if any) was
-- read before its text was kept: the heal (api/heal-pattern-text.ts) reads
-- those, a few at a time, and clears the flag. A pattern made from now on has
-- no row until a PDF lands on it; its own text (a pattern saved from Ask Cobb)
-- is its description, which search already reads.
--
-- One trigram index over the lower-cased text serves the substring search
-- (lower(coalesce(text,'')) LIKE '%word%'), as inventory's search_blob does.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS projects_pattern_texts;
--   DELETE FROM migrations WHERE name = '0006_pattern_text.sql';

create extension if not exists pg_trgm;

create table if not exists projects_pattern_texts (
  project_id uuid primary key references projects_projects(id) on delete cascade,
  pattern_file_id uuid,
  text text,
  pending boolean not null default false,
  indexed_at timestamptz not null default now()
);

insert into projects_pattern_texts (project_id, pending)
select id, true from projects_projects
on conflict (project_id) do nothing;

create index if not exists projects_pattern_texts_text_trgm
  on projects_pattern_texts using gin (lower(coalesce(text, '')) gin_trgm_ops);

create index if not exists projects_pattern_texts_pending
  on projects_pattern_texts (project_id) where pending;
