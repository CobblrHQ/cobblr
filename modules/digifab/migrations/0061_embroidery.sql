ALTER TABLE digifab_jobs ADD COLUMN IF NOT EXISTS embroidery_run boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS digifab_embroidery_machines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), config jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS digifab_embroidery_designs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, file_id uuid NOT NULL,
 source_hash text NOT NULL, design jsonb NOT NULL, summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS digifab_embroidery_runs (
 job_id uuid PRIMARY KEY REFERENCES digifab_jobs(id),
 machine_id uuid NOT NULL REFERENCES digifab_embroidery_machines(id),
 design_id uuid NOT NULL REFERENCES digifab_embroidery_designs(id), plan jsonb NOT NULL,
 started_at timestamptz, interrupted boolean NOT NULL DEFAULT false,
 report jsonb, stock_recorded_at timestamptz, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS embroidery_one_pending_run ON digifab_embroidery_runs(machine_id) WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS digifab_embroidery_thread_claims (
 part_id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES digifab_embroidery_runs(job_id)
);
