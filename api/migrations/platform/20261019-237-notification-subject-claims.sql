-- What a person has already been told today, by subject (#7464). Additive.
--
-- A calendar-raised notice names what it is about; the notifier claims each
-- subject once per person per day, so two producers noticing the same thing,
-- or overlapping sets of things, say each of them once. The claim is made
-- before the notice is written, so two producers at once cannot both win.
CREATE TABLE IF NOT EXISTS notification_subject_claims (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  day text NOT NULL,
  subject text NOT NULL,
  notification_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, day, subject)
);
CREATE INDEX IF NOT EXISTS notification_subject_claims_claimed_at
  ON notification_subject_claims (claimed_at);
