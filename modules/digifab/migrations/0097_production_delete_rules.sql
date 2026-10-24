ALTER TABLE digifab_test_plan_versions DROP CONSTRAINT IF EXISTS digifab_test_plan_versions_plan_id_fkey;
ALTER TABLE digifab_test_plan_versions ADD CONSTRAINT digifab_test_plan_versions_plan_id_fkey
  FOREIGN KEY (plan_id) REFERENCES digifab_test_plans(id) ON DELETE RESTRICT;
ALTER TABLE digifab_test_runs DROP CONSTRAINT IF EXISTS digifab_test_runs_plan_id_plan_version_fkey;
ALTER TABLE digifab_test_runs ADD CONSTRAINT digifab_test_runs_plan_id_plan_version_fkey
  FOREIGN KEY (plan_id, plan_version) REFERENCES digifab_test_plan_versions(plan_id, version) ON DELETE RESTRICT;
ALTER TABLE digifab_test_dispositions DROP CONSTRAINT IF EXISTS digifab_test_dispositions_run_id_fkey;
ALTER TABLE digifab_test_dispositions ADD CONSTRAINT digifab_test_dispositions_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES digifab_test_runs(id) ON DELETE RESTRICT;
ALTER TABLE digifab_test_delivery DROP CONSTRAINT IF EXISTS digifab_test_delivery_run_id_fkey;
ALTER TABLE digifab_test_delivery ADD CONSTRAINT digifab_test_delivery_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES digifab_test_runs(id) ON DELETE CASCADE;
