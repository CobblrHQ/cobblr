-- An Undo is exact, or it says no (#7924). Each issued undo step keeps the
-- records it would put back (watch_ids) and the newest change it saw on them
-- (seen_activity_id): pressed after someone changed them, it refuses and says
-- what changed, rather than undoing their change too. Additive: a step issued
-- before this has no version and is judged as before.
ALTER TABLE issued_undos ADD COLUMN IF NOT EXISTS watch_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE issued_undos ADD COLUMN IF NOT EXISTS seen_activity_id bigint;
