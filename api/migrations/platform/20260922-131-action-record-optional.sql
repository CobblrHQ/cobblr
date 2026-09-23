-- An entity-scoped action that may ALSO run with no record: its handler reads
-- the record when there is one and its arguments when there is not. The case
-- is lists:add-item: a low-stock wire adds THIS part to the shopping list, and
-- a person says "put milk on the shopping list", where milk is not a record.
-- The invoke door required a record for every entity action, so the action's
-- own example sentence could not run (2026-09-22). Additive with a default,
-- so every row reads false until registry-sync writes the manifest's value on
-- boot.
ALTER TABLE entity_actions
  ADD COLUMN IF NOT EXISTS record_optional boolean NOT NULL DEFAULT false;
