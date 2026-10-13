-- A recount: everything of a collection (or one category of it) scanned
-- again across every place (#6302). The session stays open for days; each
-- scan is a row, matched to one expected record or noted as something new.
-- One record is counted at most once per recount, whichever phone scanned
-- it: the unique index is what two phones scanning at once cannot get past.
CREATE TABLE IF NOT EXISTS inventory_recounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope jsonb NOT NULL,
  scope_label text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_recounts_status_idx ON inventory_recounts (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS inventory_recount_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recount_id uuid NOT NULL REFERENCES inventory_recounts(id) ON DELETE CASCADE,
  record_id uuid,
  like_id uuid,
  matched_by text NOT NULL,
  title text NOT NULL,
  barcode text,
  attributes jsonb NOT NULL DEFAULT '{}',
  place_id uuid,
  amount numeric,
  scanned_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_recount_scans_one_record ON inventory_recount_scans (recount_id, record_id) WHERE record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_recount_scans_recount_idx ON inventory_recount_scans (recount_id, created_at);
