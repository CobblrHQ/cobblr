-- Which reminder an order's due date has had (#6671): the date it was about
-- and whether it was "due tomorrow" or "late". A moved due date re-arms it.
-- Additive: null for every order, so each open one is reminded once.
alter table sales_orders add column if not exists due_reminded_for date;
alter table sales_orders add column if not exists due_reminded_state text;
