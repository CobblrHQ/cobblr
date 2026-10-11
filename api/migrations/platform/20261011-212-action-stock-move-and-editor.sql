-- An action declares when it is a station's own stock move (`stockMove` in
-- the manifest: use, add, total) and when it edits a record's fields from
-- what a person types (`editor`), so a kiosk that already shows "Used one"
-- and "+1" does not offer "Use one" and "Restock one" beside them, and never
-- offers an editor (#5710). Null and false for every action until the
-- registry sync writes the manifests'. Additive.
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_actions DROP COLUMN IF EXISTS stock_move;
--   ALTER TABLE entity_actions DROP COLUMN IF EXISTS editor;
--   DELETE FROM migrations WHERE name = '20261011-212-action-stock-move-and-editor.sql';

alter table entity_actions add column if not exists stock_move text;
alter table entity_actions add column if not exists editor boolean not null default false;
