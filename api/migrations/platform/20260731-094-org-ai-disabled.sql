-- Per-workspace AI opt-out. Even when the instance has AI on (and a managed
-- provider makes it auto-available), a workspace owner can turn shared AI off
-- for their workspace. A user's OWN personal connection still works — this
-- only gates the workspace/managed default path. Additive + defaults false, so
-- every existing workspace is unchanged (AI stays on).
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS ai_disabled boolean NOT NULL DEFAULT false;
