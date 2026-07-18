-- Receipt confirm-all (and the receipt group views) walk every line item
-- sharing a receipt_group_id via suggested_metadata->>'receipt_group_id'.
-- That was a sequential scan over the whole inbox per receipt; a partial
-- expression index makes it a lookup. Partial: only rows that ARE receipt
-- lines carry the key, so the index stays tiny on scan-heavy workspaces.
create index if not exists core_scan_inbox_receipt_group_idx
  on core_scan_inbox_items ((suggested_metadata->>'receipt_group_id'))
  where suggested_metadata->>'receipt_group_id' is not null;
