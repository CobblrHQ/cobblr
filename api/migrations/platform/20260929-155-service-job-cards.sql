-- The cards a service job has sent to people (services.md section 9): a
-- confirm, a stuck run, anything a person is asked about one job. One row per
-- (job, kind, person) holding the notification it sent, so asking again sends
-- nothing new, and settling the question (a yes, a retry, the job moving on)
-- withdraws exactly those cards. Keyed by workspace in meta, beside the
-- notifications it points at. Additive.
CREATE TABLE IF NOT EXISTS service_job_cards (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
  user_id uuid NOT NULL,
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (org_id, job_id, kind, user_id)
);

-- Which jobs are waiting for a person's yes, and since when, in meta so the
-- expiry sweep asks only the workspaces that hold one past its day and opens
-- no tenant database on a round with nothing to expire.
CREATE TABLE IF NOT EXISTS service_pending_confirms (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, job_id)
);
CREATE INDEX IF NOT EXISTS service_pending_confirms_since ON service_pending_confirms (since);
