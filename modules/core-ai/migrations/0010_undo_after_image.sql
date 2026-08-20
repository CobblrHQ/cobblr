-- Undo means "put it back the way it was", not "do the opposite".
--
-- The ledger already stored a BEFORE image. What it could not do is tell
-- whether the record still looks the way this change left it: something else
-- may have touched it since (another person, a wire, a later chat turn), and
-- reverting blindly would throw that away without saying so.
--
-- So each change also records what it PRODUCED, and a hash of it. At undo time
-- the record is hashed again: equal means this change is still the top of that
-- record's history and the revert is exact; different means it is reported, not
-- silently overwritten.
ALTER TABLE core_ai_chat_writes ADD COLUMN IF NOT EXISTS after jsonb;
ALTER TABLE core_ai_chat_writes ADD COLUMN IF NOT EXISTS after_hash text;

-- Undoing a whole instruction ("each rack should have Shelf 1 through 5") means
-- finding its changes by the turn that made them, newest first.
CREATE INDEX IF NOT EXISTS core_ai_chat_writes_turn_idx
  ON core_ai_chat_writes (turn_id, created_at DESC)
  WHERE turn_id IS NOT NULL;
