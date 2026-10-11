-- How many of a line's units are in hand (#5734): a line of ten spools
-- reads "3 of 10 received" while they are scanned in one by one, and is
-- received when the tenth arrives. Null until a unit is counted; a line
-- received whole (the order arrived) never needs it.
-- Additive.

alter table purchases_order_items add column if not exists received_qty numeric;
