-- Which face a verb belongs to, for disclosure.
--
-- An action's appliesTo says where it is ELIGIBLE (facts about the thing);
-- this says which face a person's choice hides it under. Turning the service
-- log off on a tool collection takes "Log service" off the record along with
-- the warranty fields, without pretending the drill is not serviceable.
-- Additive with a NULL default (the base record, never hidden); registry-sync
-- rewrites the real value from each manifest on the next boot.
ALTER TABLE entity_actions
  ADD COLUMN IF NOT EXISTS face text NULL;
