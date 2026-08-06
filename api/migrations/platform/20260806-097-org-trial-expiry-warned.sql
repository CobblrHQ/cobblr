-- try/trial tier: when the humane reaper sent this workspace its "trial ends
-- soon" warning email. NULL = never warned. Set only by the reaper's warn pass
-- (platform/reap-trials.ts) on the `try` instance; every other row stays NULL.
--
-- The reaper's lifecycle is warn -> grace -> delete: a workspace is only ever
-- deleted once it has been warned at least (grace) days ago AND is past
-- (trial_expires_at + grace). This column is what makes "never a silent delete"
-- enforceable — an un-warned trial can never be reaped.
--
-- Additive + nullable, so it is a no-op on prod/staging/self-host (the same
-- platform migration runs on every cobblr_meta; only `try` ever populates it).
--
-- manual recovery if this fails partway:
--   ALTER TABLE orgs DROP COLUMN trial_expiry_warned_at;

alter table orgs add column trial_expiry_warned_at timestamptz;
