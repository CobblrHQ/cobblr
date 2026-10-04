alter table sales_orders add column source_name text;
alter table sales_orders add column source_ref text;
alter table sales_orders add column source_url text;
alter table sales_orders add constraint sales_order_source_pair check ((source_name is null) = (source_ref is null));
create unique index sales_orders_source_once on sales_orders(instance, source_name, source_ref) where source_name is not null;
