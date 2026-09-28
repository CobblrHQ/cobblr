-- An action declares what it does to a dated thing that is due (`finishes` in
-- the manifest: used, discarded, still-good), so a surface listing what is due
-- offers the verbs that settle it without naming any module's action ids.
-- Null for every action until the registry sync writes the manifests'.
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_actions DROP COLUMN IF EXISTS finishes;
--   DELETE FROM migrations WHERE name = '20260928-141-action-finishes.sql';

alter table entity_actions add column if not exists finishes text;
