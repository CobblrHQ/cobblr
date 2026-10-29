-- A hold: a draft order that sets stock aside for a customer (#8838).
-- held_at says the order holds its lines' stock; hold_until is the optional day it lets go.
-- sales_holds is what this order holds, per line, so what a second order may take is known
-- here (inventory carries the same reservation, so the item shows "held for <name>").
alter table sales_orders add column if not exists held_at timestamptz;
alter table sales_orders add column if not exists hold_until date;

create table sales_holds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales_orders(id) on delete cascade,
  line_id uuid not null references sales_order_items(id) on delete cascade,
  part_id uuid not null,
  qty numeric not null check (qty > 0),
  created_at timestamptz not null default now()
);
create index sales_holds_part_idx on sales_holds(part_id);
create index sales_holds_order_idx on sales_holds(order_id);

alter table sales_order_history drop constraint if exists sales_order_history_kind_check;
alter table sales_order_history add constraint sales_order_history_kind_check
  check (kind in ('status', 'stock', 'shipped', 'email', 'work_order', 'line', 'delivered', 'return', 'payment', 'hold'));
