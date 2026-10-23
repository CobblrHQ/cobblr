-- A received package can be deleted (#7905). Its receipt row had no delete
-- rule, so deleting the package failed on the foreign key. The receipt now
-- goes with the package (and with the type it was received as), and comes
-- back with it on Undo: the deletion snapshot keeps every cascaded inventory_
-- row and restores it beside the package.
ALTER TABLE inventory_package_receipts DROP CONSTRAINT IF EXISTS inventory_package_receipts_part_id_fkey;
ALTER TABLE inventory_package_receipts ADD CONSTRAINT inventory_package_receipts_part_id_fkey
  FOREIGN KEY (part_id) REFERENCES inventory_parts(id) ON DELETE CASCADE;
ALTER TABLE inventory_package_receipts DROP CONSTRAINT IF EXISTS inventory_package_receipts_type_id_fkey;
ALTER TABLE inventory_package_receipts ADD CONSTRAINT inventory_package_receipts_type_id_fkey
  FOREIGN KEY (type_id) REFERENCES inventory_parts(id) ON DELETE CASCADE;
