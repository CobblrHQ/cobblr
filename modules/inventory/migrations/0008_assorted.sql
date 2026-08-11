-- Assorted contents: a record that stands for "roughly this many of these,
-- jumbled together" rather than for one counted thing.
--
-- A bin of fifty adapters nobody will ever enumerate still has to be findable,
-- and rendering its whole contents as one thin list row makes a full bin look
-- empty. See docs/design-decisions/assorted-contents.md.
--
-- Both columns are nullable and additive, so a row that has never been an
-- estimate is untouched and the previously deployed api ignores them.
--
--   approximate_qty  "roughly 50". Its PRESENCE is the signal that this record
--                    is an estimate rather than a count, which is what earns it
--                    the soft, photo-led card instead of a row. Deliberately
--                    separate from `qty`: a record can be counted (qty) or
--                    estimated (approximate_qty), and conflating them would
--                    make an estimate arithmetic.
--   estimated_at     when the guess was made, so a two-year-old estimate can
--                    eventually present itself as one. Nothing reads this yet.

alter table inventory_parts
  add column approximate_qty numeric(12,3),
  add column estimated_at    timestamptz;

-- Only assortments, and there are few of them per workspace, so a partial index
-- keeps this off the hot path for ordinary parts.
create index inventory_parts_assorted_idx
  on inventory_parts(instance)
  where approximate_qty is not null;
