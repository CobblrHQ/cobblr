-- A receipt session remembers the ORIGINAL it was parsed from (the uploaded
-- PDF/photo, or the emailed body captured as a file), so the inbox can offer
-- "View original" and "Re-parse". Additive + nullable — plain scan sessions and
-- pre-existing receipts stay source-less and simply don't show those actions.

alter table core_scan_batches add column if not exists source_file_id uuid;
