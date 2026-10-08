ALTER TABLE digifab_jobs
  ADD COLUMN make_id uuid REFERENCES digifab_makes(id) ON DELETE SET NULL,
  ADD COLUMN make_ordinal integer CHECK (make_ordinal > 0);

CREATE UNIQUE INDEX digifab_jobs_make_ordinal
  ON digifab_jobs(make_id, make_ordinal) WHERE make_ordinal IS NOT NULL;
