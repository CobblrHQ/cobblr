-- An order's history also says when a line was added, changed or removed, so
-- its timeline and the workspace log carry every change to what was sold.
-- Widens the kind check; no row changes.
alter table sales_order_history drop constraint if exists sales_order_history_kind_check;
alter table sales_order_history add constraint sales_order_history_kind_check
  check (kind in ('status', 'stock', 'shipped', 'email', 'work_order', 'line'));
