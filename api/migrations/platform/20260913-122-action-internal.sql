-- An action that exists only as the way back for another.
--
-- The undo rail runs it through the actions route; nothing else may reach
-- it, and the assistant must not see it in the registry (it carried
-- "put it back" as a phrasing and could be offered on a confirm card).
-- Additive with a default so every row reads false until registry-sync
-- rewrites the real value from each manifest on the next boot.
ALTER TABLE entity_actions
  ADD COLUMN IF NOT EXISTS internal boolean NOT NULL DEFAULT false;
