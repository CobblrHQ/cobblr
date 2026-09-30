-- How many of each line have actually left stock. Fulfilment ships what is on
-- hand when a person chooses "Ship the N you have", so a line can be part-way
-- shipped and the order stays open for the rest (#4050). Additive, defaulted.
alter table sales_order_items add column if not exists qty_fulfilled numeric not null default 0;

-- An order already fulfilled, shipped or closed shipped its lines in full as
-- far as the order knows, so its lines say so rather than "0 shipped".
update sales_order_items i
   set qty_fulfilled = i.qty
  from sales_orders o
 where o.id = i.order_id
   and o.status in ('fulfilled', 'shipped', 'closed')
   and i.qty_fulfilled = 0;
