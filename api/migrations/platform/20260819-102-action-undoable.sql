-- Whether running an action by mistake can be put right inside the workspace.
--
-- Decides whether an AI connection that cannot show a confirmation prompt may
-- run it. Additive with a DEFAULT of false, which is the safe answer: an older
-- api reading this table ignores the column, and a newer one treats every
-- unsynced row as "needs a person". registry-sync rewrites the real value from
-- each manifest on the next boot, so nothing has to be backfilled by hand.
ALTER TABLE entity_actions
  ADD COLUMN IF NOT EXISTS undoable boolean NOT NULL DEFAULT false;
