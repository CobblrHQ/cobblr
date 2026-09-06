-- "No" is an answer an invite could not record.
--
-- Accepting had an endpoint; declining had nothing. An invite you did not want
-- could only be ignored, so it sat unread in the bell forever and the person who
-- sent it never learned the outcome, watching it expire instead (reported
-- 2026-09-06, on a notification with no buttons on it).
--
-- Additive and nullable: null means unanswered, which is every existing row, so
-- nothing already deployed reads differently.
ALTER TABLE workspace_invites
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_by_user uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN workspace_invites.declined_at IS
  'When the invited person said no. Null = unanswered. Distinct from consumed_at (accepted) and revoked_at (withdrawn by the inviter).';
