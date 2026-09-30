-- What running an action does to the world (`exposes.actions[].effect`:
-- none, writes, physical, spends), kept beside `undoable` so every door that
-- decides whether a person must confirm reads the same declaration. Null is
-- an action that declared none. Re-synced from the manifests on every boot.
-- Additive.
ALTER TABLE entity_actions ADD COLUMN IF NOT EXISTS effect text;
