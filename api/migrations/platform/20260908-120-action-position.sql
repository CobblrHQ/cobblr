-- Where in its module's manifest an action was declared.
--
-- The actions strip on a record listed by action ID, which is alphabetical by
-- MODULE name first: every "core-*" action led every record, and the record's
-- own verbs sat behind a "+N more" fold. Manifest order is the author's order,
-- so it is the order a person sees. Additive with a DEFAULT of 0; registry-sync
-- rewrites the real value from each manifest on the next boot, so nothing is
-- backfilled by hand and an older api ignores the column.
ALTER TABLE entity_actions
  ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
