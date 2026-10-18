-- Production test evidence: a run's fixture wiring gets its own protected
-- column (#7174).
--
-- Additive (lint:migration-additive): one new nullable column, a backfill of it,
-- and the immutability function also refusing an edit to the legacy metadata
-- copy of the wiring. The deployed api writes and reads metadata.jig_pins,
-- which stays written and is now only protected.
--
-- manual recovery if this fails partway:
--   alter table digifab_test_runs enable trigger digifab_test_run_immutable;
--   alter table digifab_test_runs drop column if exists jig_pins;

-- A run's fixture wiring is evidence, not an annotation (#7174): it moves out of
-- the editable metadata into its own column, which the immutability trigger
-- already covers, and the legacy metadata copy can no longer be edited either.
ALTER TABLE digifab_test_runs ADD COLUMN IF NOT EXISTS jig_pins jsonb;
ALTER TABLE digifab_test_runs DISABLE TRIGGER digifab_test_run_immutable;
UPDATE digifab_test_runs SET jig_pins = metadata->'jig_pins' WHERE jig_pins IS NULL AND metadata ? 'jig_pins';
ALTER TABLE digifab_test_runs ENABLE TRIGGER digifab_test_run_immutable;

CREATE OR REPLACE FUNCTION digifab_test_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Custom fields annotate an attempt; they are not its evidence, so they alone may change.
 -- Nested, not one AND: plpgsql does not short-circuit, and another table has no metadata.
 IF TG_TABLE_NAME = 'digifab_test_runs' AND TG_OP = 'UPDATE' THEN
  IF (to_jsonb(NEW) - 'metadata') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'metadata')
     AND (to_jsonb(NEW)->'metadata'->'jig_pins') IS NOT DISTINCT FROM (to_jsonb(OLD)->'metadata'->'jig_pins') THEN
   RETURN NEW;
  END IF;
 END IF;
 IF TG_TABLE_NAME <> 'digifab_test_runs' THEN
  RAISE EXCEPTION 'Finished production evidence is immutable';
 END IF;
 IF OLD.finished_at IS NOT NULL THEN
  RAISE EXCEPTION 'Finished production evidence is immutable';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 IF (to_jsonb(NEW) - 'result' - 'finished_at') IS DISTINCT FROM (to_jsonb(OLD) - 'result' - 'finished_at') THEN
  RAISE EXCEPTION 'Prepared production evidence is immutable';
 END IF;
 RETURN NEW;
END $$;
