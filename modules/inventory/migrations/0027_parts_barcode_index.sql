-- A scanned code that is already on a record is found from an index, never a
-- scan of every part (#6436): "this known barcode in the local workspace
-- literally needs to resolve instantly". The scanner's own-record lookup asks
-- for metadata->>'barcode' = <code> once per collection and spelling.
CREATE INDEX IF NOT EXISTS inventory_parts_barcode_idx ON inventory_parts ((metadata->>'barcode'));
