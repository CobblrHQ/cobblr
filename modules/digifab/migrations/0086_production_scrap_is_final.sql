-- Production test: a scrapped unit stays scrapped under overlapping writes
-- (#7175).
--
-- Additive (lint:migration-additive): a new function and two new insert
-- triggers. The deployed api's own checks already refuse every write these
-- refuse; the triggers only close the window between its check and its write.
--
-- manual recovery if this fails partway:
--   drop trigger if exists digifab_test_run_unit_guard on digifab_test_runs;
--   drop trigger if exists digifab_test_disposition_unit_guard on digifab_test_dispositions;
--   drop function if exists digifab_test_unit_guard();

-- A scrapped unit stays scrapped (#7175). Every new attempt and every
-- disposition takes the unit's lock (the one prepare takes) and re-reads its
-- latest attempt, so two screens that both checked before either wrote cannot
-- both win: whichever commits second is refused here.
CREATE OR REPLACE FUNCTION digifab_test_unit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u_kind text; u_id uuid; latest uuid;
BEGIN
 IF TG_TABLE_NAME = 'digifab_test_dispositions' THEN
  SELECT unit_kind, unit_id INTO u_kind, u_id FROM digifab_test_runs WHERE id = NEW.run_id;
 ELSE
  u_kind := NEW.unit_kind; u_id := NEW.unit_id;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtext('production-unit:' || u_kind || ':' || u_id::text));
 SELECT id INTO latest FROM digifab_test_runs WHERE unit_kind = u_kind AND unit_id = u_id ORDER BY attempt DESC LIMIT 1;
 IF latest IS NOT NULL AND EXISTS (SELECT 1 FROM digifab_test_dispositions WHERE run_id = latest AND status = 'scrapped') THEN
  RAISE EXCEPTION 'This unit is scrapped. Keep its test history.';
 END IF;
 IF TG_TABLE_NAME = 'digifab_test_dispositions' THEN
  IF latest IS DISTINCT FROM NEW.run_id THEN
   RAISE EXCEPTION 'Use the unit''s latest failed attempt. Scrapped evidence stays on file.';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS digifab_test_run_unit_guard ON digifab_test_runs;
CREATE TRIGGER digifab_test_run_unit_guard BEFORE INSERT ON digifab_test_runs FOR EACH ROW EXECUTE FUNCTION digifab_test_unit_guard();
DROP TRIGGER IF EXISTS digifab_test_disposition_unit_guard ON digifab_test_dispositions;
CREATE TRIGGER digifab_test_disposition_unit_guard BEFORE INSERT ON digifab_test_dispositions FOR EACH ROW EXECUTE FUNCTION digifab_test_unit_guard();
