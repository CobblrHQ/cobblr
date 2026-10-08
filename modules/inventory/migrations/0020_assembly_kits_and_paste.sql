CREATE TABLE IF NOT EXISTS inventory_paste_storage (
  part_id uuid PRIMARY KEY REFERENCES inventory_parts(id) ON DELETE CASCADE,
  state jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_allocations ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}';
