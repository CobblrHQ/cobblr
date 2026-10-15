-- When the customer wants an order: a job shop's orders are its due dates. Additive: null for every
-- order that has none.
alter table sales_orders add column if not exists due_date date;
create index if not exists sales_orders_due on sales_orders(instance, due_date) where due_date is not null;
