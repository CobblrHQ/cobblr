-- An order's history also says when something was put in to be made for it
-- (a work order from "Make this", #4052). Widens the kind check; no row
-- changes.
alter table sales_order_history drop constraint if exists sales_order_history_kind_check;
alter table sales_order_history add constraint sales_order_history_kind_check
  check (kind in ('status', 'stock', 'shipped', 'email', 'work_order'));
