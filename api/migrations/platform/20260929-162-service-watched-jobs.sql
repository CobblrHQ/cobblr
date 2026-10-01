-- The Services supervisor's watch list (services.md S9): every job still
-- moving, and every finished one whose next step it has not yet checked, by
-- workspace, in meta. A sweep round asks this table which workspaces to open,
-- so a workspace with no live work costs nothing. The kernel's job events keep
-- it; the supervisor deletes a row once there is nothing left to watch.
-- Additive.
CREATE TABLE IF NOT EXISTS service_watched_jobs (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  status text NOT NULL,
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, job_id)
);
CREATE INDEX IF NOT EXISTS service_watched_jobs_org ON service_watched_jobs (org_id);
