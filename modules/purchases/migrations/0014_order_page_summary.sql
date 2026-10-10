-- What an order's page said about the order itself: its name and its lines,
-- with no link in it (#5461 follow-up). Kept so a receipt in the scan inbox
-- can be filled from it with no model, and read again without spending
-- another read of the link, which may wear down to the guest view after a
-- few uses. The guest view still names the order and its lines, so a later
-- redacted read never empties it.
-- Additive.

alter table purchases_order_pages add column if not exists page_order jsonb;
