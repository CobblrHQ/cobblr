-- What a customer sent back and what was refunded for it (#8790).
-- A return puts goods back on the shelf (qty on a line) and/or records a refund
-- (an amount on the order); either may stand alone (a refund for a cancelled
-- paid order has no goods). The line says how many have come back, so a later
-- cancel puts back only what is still out.
alter table sales_order_items add column if not exists qty_returned numeric not null default 0;

create table sales_returns (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales_orders(id) on delete cascade,
  line_id uuid references sales_order_items(id) on delete set null,
  qty numeric check (qty is null or qty > 0),
  restocked numeric not null default 0,
  refund_amount numeric check (refund_amount is null or refund_amount >= 0),
  reason text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index sales_returns_order_idx on sales_returns(order_id, created_at);

alter table sales_order_history drop constraint if exists sales_order_history_kind_check;
alter table sales_order_history add constraint sales_order_history_kind_check
  check (kind in ('status', 'stock', 'shipped', 'email', 'work_order', 'line', 'delivered', 'return'));
