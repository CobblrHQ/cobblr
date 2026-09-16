-- Per-USER title format: how a titled work with an original title, a
-- translation and a transliteration reads on a card ("Желтый туман (Yellow
-- Fog)"). A personal preference that follows the person across devices and
-- workspaces, like theme_pref (074): NULL = no choice made, the default
-- format stands. The stored title variants stay separate on the row; this
-- only says how they are shown (#3061).
alter table users add column if not exists title_pref text;

-- manual recovery: ALTER TABLE users DROP COLUMN IF EXISTS title_pref;
