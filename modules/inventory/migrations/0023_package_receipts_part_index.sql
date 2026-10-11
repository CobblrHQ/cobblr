-- A package receipt points at the part it brought in and the part type it is
-- for, with no index on either: every delete of a part had to scan the whole
-- receipts table, twice, to check nothing still pointed at it, and the table
-- grows with every package received (#5286).
CREATE INDEX IF NOT EXISTS inventory_package_receipts_part ON inventory_package_receipts(part_id);
CREATE INDEX IF NOT EXISTS inventory_package_receipts_type ON inventory_package_receipts(type_id);
