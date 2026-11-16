-- One sales order, several parcels (#9505).
--
-- An order that goes out in two goes (what is on the shelf now, the rest when
-- it is made) had nowhere to say how the first one went: Ship wanted every
-- line in stock, so the first parcel left with no tracking number, no carrier
-- and no date. A parcel is one box of an order: when it left, which carrier and
-- tracking number it went with (both optional until a person has them), and
-- which lines it carries and how many. The purchases side keeps the same shape
-- (purchases_order_shipments).
--
-- A line's stock taken out (qty_fulfilled) is not yet a parcel: it reads "taken
-- from stock" until a parcel carries it, and an order reads shipped only when
-- every stocked line is wholly in parcels. Additive; an order already shipped
-- before this gets its one parcel from the boot heal.

create table if not exists sales_order_parcels (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales_orders(id) on delete cascade,
  tracking_number text,
  carrier text,
  shipped_at timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sales_order_parcels_order_idx on sales_order_parcels(order_id, shipped_at);

create table if not exists sales_order_parcel_lines (
  parcel_id uuid not null references sales_order_parcels(id) on delete cascade,
  item_id uuid not null references sales_order_items(id) on delete cascade,
  qty numeric not null check (qty > 0),
  primary key (parcel_id, item_id)
);

create index if not exists sales_order_parcel_lines_item_idx on sales_order_parcel_lines(item_id);
