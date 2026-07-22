-- try/trial tier: a workspace's trial expiry stamp. NULL = a normal (non-trial)
-- workspace — every existing row, and every workspace on a non-`try` instance.
-- Set ONLY on the `try` instance (COBBLR_TIER=trial) at signup, to now()+TTL, so
-- `trial_expires_at IS NOT NULL` identifies a trial workspace.
--
-- Reaping is DEFERRED: the sweep (TRY_REAP_ENABLED) is off initially, so this is
-- just a stamp and nothing auto-deletes. When it is turned on it is humane — back
-- up the workspace, return the data to the user, then delete after a grace window.
-- See docs/design-decisions/try-instance.md.
--
-- Additive + nullable, so it is a no-op on prod/staging/self-host (the same
-- platform migration runs on every cobblr_meta; only `try` ever populates it).
--
-- manual recovery if this fails partway:
--   DROP INDEX IF EXISTS orgs_trial_expires_at_idx;
--   ALTER TABLE orgs DROP COLUMN trial_expires_at;

alter table orgs add column trial_expires_at timestamptz;

-- Partial index for the future reaper sweep — indexes only the (few) trial rows,
-- costs nothing on instances that never set the column.
create index orgs_trial_expires_at_idx on orgs (trial_expires_at)
  where trial_expires_at is not null;
