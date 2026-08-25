-- A fingerprint for receipts that print no order number, so scanning the same
-- till receipt twice can be caught the way an order-numbered one already is.
-- vendor|date|total|line-count, computed at parse time; null when the parse
-- established too little to fingerprint honestly.
alter table core_scan_batches add column if not exists content_key text;
create index if not exists core_scan_batches_content_key
  on core_scan_batches (content_key) where content_key is not null;
