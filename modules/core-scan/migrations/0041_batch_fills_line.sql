-- A scan session bound to an order line (#5734): "Scan the items" opens it,
-- and every scan made in it, by camera, scanner or photo, is counted as one
-- of that line's units once its match settles. Null for every other session.
-- Additive.

alter table core_scan_batches add column if not exists fills_line uuid;
