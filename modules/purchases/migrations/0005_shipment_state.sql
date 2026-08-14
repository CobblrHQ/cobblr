-- What the carrier last said about an order, and how much we believe its date.
--
-- All additive and all nullable: an order that has never been followed reads
-- null everywhere, which is exactly "we have not asked", and every rule treats
-- that as no claim rather than as a claim of nothing.
--
-- `eta_source` is the rank behind expected_arrival. Without it a freshly typed
-- tracking number that returns no data would look indistinguishable from a
-- carrier saying "no date", and the receipt's estimate would be erased by
-- silence.

alter table purchases_orders add column shipment_state       text;
alter table purchases_orders add column shipment_checked_at  timestamptz;
alter table purchases_orders add column shipment_next_poll_at timestamptz;
-- none | receipt | carrier | out-for-delivery | delivered
alter table purchases_orders add column eta_source           text;

-- Which carrier state an ask was about, so "delivered" asks once rather than
-- on every hourly tick while the parcel sits on the porch.
alter table purchases_arrival_asks add column carrier_state text;
