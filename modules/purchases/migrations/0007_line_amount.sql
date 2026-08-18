-- What the line actually said, alongside what one of them costs.
--
-- An order line stores a per-unit cost, so a receipt line whose amount does not
-- divide evenly into its quantity cannot round-trip: 1.50 over qty 4 is 0.375,
-- money is two decimals, and 4 x 0.38 reconstructs 1.52. Two cents, bounded at
-- half a cent per unit -- small, and still wrong on a record somebody may read
-- back later. Found by running a receipt through staging and checking the
-- arithmetic rather than by any test.
--
-- So the line keeps the amount it was given. unit_cost stays the primary field
-- (every existing reader uses it, and it is the right thing to show per item);
-- this is the source value it was derived FROM, authoritative when present.
--
-- Nullable and additive: every existing row keeps working, and a line whose
-- receipt only ever stated a unit price simply has none.
alter table purchases_order_items add column if not exists line_amount numeric;

comment on column purchases_order_items.line_amount is
  'The amount the source line stated, when it stated one. unit_cost may be a '
  'derived per-unit figure that does not multiply back exactly; this does not.';
