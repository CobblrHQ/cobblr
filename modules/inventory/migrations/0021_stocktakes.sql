-- A stocktake: "here is what is still in the Fridge, the rest is gone". One
-- row per run keeps what it kept, what it marked gone and every quantity it
-- set, so the whole run has one Undo, from its card and from the activity
-- line that links here, and Undo puts each record back exactly as it was.
CREATE TABLE IF NOT EXISTS inventory_stocktakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope jsonb NOT NULL,
  scope_label text NOT NULL,
  kept jsonb NOT NULL DEFAULT '[]',
  gone jsonb NOT NULL DEFAULT '[]',
  counted jsonb NOT NULL DEFAULT '[]',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by uuid
);
CREATE INDEX IF NOT EXISTS inventory_stocktakes_created_idx ON inventory_stocktakes (created_at DESC);
