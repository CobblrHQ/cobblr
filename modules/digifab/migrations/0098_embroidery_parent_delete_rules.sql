ALTER TABLE digifab_embroidery_runs DROP CONSTRAINT IF EXISTS digifab_embroidery_runs_job_id_fkey;
ALTER TABLE digifab_embroidery_runs ADD CONSTRAINT digifab_embroidery_runs_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES digifab_jobs(id) ON DELETE CASCADE;
ALTER TABLE digifab_embroidery_runs DROP CONSTRAINT IF EXISTS digifab_embroidery_runs_machine_id_fkey;
ALTER TABLE digifab_embroidery_runs ADD CONSTRAINT digifab_embroidery_runs_machine_id_fkey
  FOREIGN KEY (machine_id) REFERENCES digifab_embroidery_machines(id) ON DELETE RESTRICT;
ALTER TABLE digifab_embroidery_runs DROP CONSTRAINT IF EXISTS digifab_embroidery_runs_design_id_fkey;
ALTER TABLE digifab_embroidery_runs ADD CONSTRAINT digifab_embroidery_runs_design_id_fkey
  FOREIGN KEY (design_id) REFERENCES digifab_embroidery_designs(id) ON DELETE RESTRICT;
ALTER TABLE digifab_embroidery_thread_claims DROP CONSTRAINT IF EXISTS digifab_embroidery_thread_claims_job_id_fkey;
ALTER TABLE digifab_embroidery_thread_claims ADD CONSTRAINT digifab_embroidery_thread_claims_job_id_fkey
  FOREIGN KEY (job_id) REFERENCES digifab_embroidery_runs(job_id) ON DELETE CASCADE;
