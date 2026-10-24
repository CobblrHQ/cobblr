ALTER TABLE builds_inspections DROP CONSTRAINT IF EXISTS builds_inspections_order_id_fkey;
ALTER TABLE builds_inspections ADD CONSTRAINT builds_inspections_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES builds_planned(id) ON DELETE CASCADE;
