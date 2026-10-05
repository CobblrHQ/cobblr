CREATE TABLE IF NOT EXISTS inventory_sheet_area (
  part_id uuid PRIMARY KEY REFERENCES inventory_parts(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0,
  state jsonb NOT NULL DEFAULT '{"used":[],"edits":[],"sources":[]}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
