-- Which door an undo step was handed through. An assistant over MCP that
-- deleted a view was handed restore-view as its way back and refused it as
-- "cannot be undone" (#7831): the step it was issued is one it may run. A
-- step issued for a person's own run in the app stays theirs alone, since an
-- assistant never presses a person's Undo (#7157), so the door is kept.
-- Additive with a default: every existing row was issued outside an AI door
-- or is a week from its sweep.
ALTER TABLE issued_undos ADD COLUMN IF NOT EXISTS ai_door boolean NOT NULL DEFAULT false;
