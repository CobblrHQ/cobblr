-- What code read from a personal document, kept on its session (#5331).
--
-- A bill of sale is a personal document (#5243): it is read on the personal
-- path and never stored (no source_file_id). Its card still offers the car
-- already here ("It's this one"), which fills the car from the document; with
-- no file to read again, the values code read (the vehicle, its price, date
-- and seller, the fees and tax as lines) are kept here instead. The values,
-- never the document. Null for every session that kept its original.
alter table core_scan_batches add column if not exists read_receipt jsonb;
