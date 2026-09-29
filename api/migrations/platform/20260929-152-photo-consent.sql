-- Keeping photos of filed items is a choice an account makes, and can change
-- (#3769 step 3, prepared). photo_terms_accepted_at already says when it said
-- yes; this says when it said no (declined the updated terms, or turned the
-- setting off after accepting). A decline wins: nothing of that account's is
-- ever kept while it stands. Every decision is also logged with its date,
-- the record a consent question is answered from. Additive.
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_terms_declined_at timestamptz;

CREATE TABLE IF NOT EXISTS photo_consent_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accept', 'decline', 'withdraw')),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_consent_log_user ON photo_consent_log (user_id, at);
