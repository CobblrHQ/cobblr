-- A receipt read while Purchases was off: what its order WOULD have been,
-- kept on the session so one tap can turn Purchases on and record it
-- (services/receipt-order.ts recordReceiptPurchase). Null once recorded, and
-- for every session that is not a receipt. Nullable, additive.
alter table core_scan_batches
  add column if not exists pending_purchase jsonb;
