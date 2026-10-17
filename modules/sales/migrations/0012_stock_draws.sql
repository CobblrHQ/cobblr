create table sales_stock_draws (
  id uuid primary key,
  order_id uuid not null references sales_orders(id) on delete cascade,
  line_id uuid not null references sales_order_items(id) on delete cascade,
  part_id uuid not null,
  qty_before numeric not null default 0,
  qty numeric not null default 0 check (qty > 0),
  completed boolean not null default false
);
create index sales_stock_draws_pending_idx on sales_stock_draws(order_id) where not completed;
