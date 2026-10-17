-- An order an importer brings in whole is keyed by what it is, so bringing it in
-- again (a retry after a lost answer, a second press) finds the first instead of
-- making a second purchase. The key lives in the order's metadata; only an
-- imported order has one. Additive: no existing row has the key.
create unique index if not exists purchases_orders_import_key_idx
  on purchases_orders ((metadata ->> 'import_key'))
  where metadata ->> 'import_key' is not null;
