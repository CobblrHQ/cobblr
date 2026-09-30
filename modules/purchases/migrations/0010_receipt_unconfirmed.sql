-- A received line whose stock may never have been added (#4115).
--
-- "Mark arrived" once marked an order arrived without adding its stock, and
-- nothing recorded which lines had been received. The arrival heal stamps
-- every past arrived line received (so none can add its stock twice) and sets
-- this on the ones that arrived after that door shipped, which a person then
-- settles: add the stock now, or say it was already counted. Additive.

alter table purchases_order_items
  add column if not exists receipt_unconfirmed boolean not null default false;

create index if not exists purchases_order_items_unconfirmed_idx
  on purchases_order_items (order_id) where receipt_unconfirmed;

-- Whether an order's lines add their stock when it arrives. On by default
-- ("I bought ten screws and they are here" adds ten); off for a purchase
-- logged after the fact, whose stock was counted long ago, so back-filling
-- history never inflates the shelf. Additive, with a default.
alter table purchases_orders
  add column if not exists add_to_stock boolean not null default true;

