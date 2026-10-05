CREATE TABLE IF NOT EXISTS digifab_reflow_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paste_kind text NOT NULL,
  paste_id uuid NOT NULL,
  fingerprint text NOT NULL,
  profile jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(paste_kind, paste_id, fingerprint)
);
