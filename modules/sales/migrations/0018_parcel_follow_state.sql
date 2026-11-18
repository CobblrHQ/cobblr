-- Following each parcel of a sales order, not just the order's own tracking
-- number (#9556).
--
-- "Follow parcels I send" read only sales_orders.tracking_number, which is set
-- when the order ships. An order that goes out in parts has one parcel per box
-- (0017), so the first boxes were never followed and the order was closed as
-- delivered on the last box's number alone. Where a box is, when it was last
-- asked about, when to ask next and when it landed now live on the parcel, the
-- same fields purchases_order_shipments keeps. The order reads delivered only
-- when every one of its parcels is. Additive.

alter table sales_order_parcels add column if not exists shipment_state text;
alter table sales_order_parcels add column if not exists shipment_checked_at timestamptz;
alter table sales_order_parcels add column if not exists shipment_next_poll_at timestamptz;
alter table sales_order_parcels add column if not exists delivered_at timestamptz;

-- A parcel that carries the order's own tracking number already has its
-- answer on the order: carry it over, once, so nothing is asked twice and a
-- delivered order is not seen as waiting on its box.
update sales_order_parcels p
   set shipment_state = o.shipment_state,
       shipment_checked_at = o.shipment_checked_at,
       shipment_next_poll_at = o.shipment_next_poll_at,
       delivered_at = o.delivered_at
  from sales_orders o
 where o.id = p.order_id
   and p.tracking_number is not null
   and p.tracking_number = o.tracking_number
   and p.shipment_state is null
   and p.delivered_at is null
   and (o.shipment_state is not null or o.delivered_at is not null);
