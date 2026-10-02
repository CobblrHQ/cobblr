-- The address an emailed receipt came from, so its session can say who sent
-- it ("Emailed from you@example.com") and name its document by the sender
-- when the read found no shop. Null for every session that was not emailed,
-- and for one emailed before this was kept. Nullable, additive.
alter table core_scan_batches
  add column if not exists origin_from text;
