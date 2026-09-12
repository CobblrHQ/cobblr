-- A count cannot be below zero.
--
-- `use-one` on a record at 0 wrote -1 and nothing said so (2026-09-12). The
-- inventory service now refuses or clamps every decrement (stock-floor.ts);
-- the column carries the same floor, so a path that forgets the rule fails
-- loudly instead of writing a minus. Additive: nothing is removed, renamed or
-- retyped; a row already below zero is put at zero first, because it was
-- never a true count.
update inventory_parts set qty = 0 where qty < 0;
alter table inventory_parts
  add constraint inventory_parts_qty_floor check (qty >= 0);
