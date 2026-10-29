-- What a customer paid on an order: a list, not a yes/no (#8838).
-- Paid, part-paid and owed come from these rows less the refunds; the
-- orders.paid column stays as a cache the older readers (the delivered-order
-- close, the wire's filters) still use, kept in step by every payment change.
create table sales_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales_orders(id) on delete cascade,
  amount numeric not null check (amount > 0),
  method text not null default 'other',
  paid_on date not null default current_date,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index sales_payments_order_idx on sales_payments(order_id, paid_on);

-- Existing paid orders become one payment of their total on their paid day.
-- Idempotent: an order that already has a payment is left alone; an order
-- whose lines are unpriced (a total of 0) has nothing to record.
insert into sales_payments (order_id, amount, method, paid_on)
select o.id, t.total, 'other', coalesce(o.paid_at::date, o.updated_at::date)
from sales_orders o
join lateral (
  select coalesce(sum(i.qty * i.unit_price), 0) as total
  from sales_order_items i where i.order_id = o.id and i.unit_price is not null
) t on true
where o.paid and t.total > 0
  and not exists (select 1 from sales_payments p where p.order_id = o.id);

alter table sales_order_history drop constraint if exists sales_order_history_kind_check;
alter table sales_order_history add constraint sales_order_history_kind_check
  check (kind in ('status', 'stock', 'shipped', 'email', 'work_order', 'line', 'delivered', 'return', 'payment'));
