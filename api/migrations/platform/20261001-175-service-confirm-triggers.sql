-- A yes given ahead of its moment (services.md section 9): "power off after
-- this print". A waiting job may carry one proposed trigger (an event and the
-- id it must name, e.g. a print finishing). A person's yes then ARMS it,
-- bound to the same hash as any confirm, until `until`; the trigger arriving
-- starts it. Withdrawn by deleting the row. Never a standing permission: one
-- job, one trigger, one yes.
CREATE TABLE IF NOT EXISTS service_confirm_triggers (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  event text NOT NULL,
  match_value text NOT NULL,
  label text NOT NULL,
  until timestamptz NOT NULL,
  confirm_hash text,
  armed_by uuid,
  armed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, job_id)
);
CREATE INDEX IF NOT EXISTS service_confirm_triggers_event ON service_confirm_triggers (event, match_value) WHERE armed_by IS NOT NULL;
