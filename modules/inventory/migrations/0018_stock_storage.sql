CREATE TABLE IF NOT EXISTS inventory_stock_storage (
  part_id uuid PRIMARY KEY REFERENCES inventory_parts(id) ON DELETE CASCADE,
  state jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_package_receipts (
  receipt_key text PRIMARY KEY,
  label_hash text NOT NULL,
  part_id uuid NOT NULL REFERENCES inventory_parts(id),
  type_id uuid NOT NULL REFERENCES inventory_parts(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  received_at timestamptz NOT NULL DEFAULT now()
);
