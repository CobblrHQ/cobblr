-- Multi-instance support — see docs/design-decisions/instances.md.

alter table purchases_orders
  add column instance text not null default 'purchases';
create index purchases_orders_instance_idx on purchases_orders(instance);

alter table purchases_order_items
  add column instance text not null default 'purchases';
create index purchases_order_items_instance_idx on purchases_order_items(instance);
