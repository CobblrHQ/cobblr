-- A button a collection puts on its own records (CobblrHQ/core#3802): a
-- user-invoked binding may carry its own label ("Open a bottle" rather than
-- the action's "Use one") and the arguments to ask for before it runs
-- (`[{ "arg": "note", "label": "Tasting note" }]`). Both null for every
-- binding that exists, which reads exactly as before: the action's label, no
-- question.
--
-- manual recovery if this fails partway:
--   ALTER TABLE entity_action_bindings DROP COLUMN IF EXISTS label, DROP COLUMN IF EXISTS ask;
--   DELETE FROM migrations WHERE name = '20260928-138-binding-label-ask.sql';

alter table entity_action_bindings add column if not exists label text;
alter table entity_action_bindings add column if not exists ask jsonb;
