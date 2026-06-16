-- sales — outbound order management: customers, sales orders, line items.
-- Closes the sale → fulfil → decrement-stock → (low-stock) reorder loop. Line
-- items optionally point at an inventory:part (weak ref, no cross-module FK);
-- fulfilling an order decrements those parts via the inventory action.
--
-- manual recovery if this fails partway:
--   DROP TABLE sales_order_items; DROP TABLE sales_orders; DROP TABLE sales_customers;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0001_init';

create table sales_customers (
  id          uuid primary key default gen_random_uuid(),
  instance    text not null default 'sales',
  name        text not null,
  email       text,
  phone       text,
  address     text,
  notes       text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index sales_customers_instance_idx on sales_customers(instance);
create index sales_customers_name_idx on sales_customers(instance, lower(name));

create table sales_orders (
  id            uuid primary key default gen_random_uuid(),
  instance      text not null default 'sales',
  customer_id   uuid references sales_customers(id) on delete set null,
  customer_name text,
  order_number  text,
  status        text not null default 'draft'
    check (status in ('draft', 'confirmed', 'fulfilled', 'shipped', 'closed', 'cancelled')),
  order_date    date,
  fulfilled_at  timestamptz,
  shipping_address text,
  notes         text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index sales_orders_instance_idx on sales_orders(instance);
create index sales_orders_customer_idx on sales_orders(customer_id);
create index sales_orders_status_idx on sales_orders(status);

create table sales_order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references sales_orders(id) on delete cascade,
  -- Optional weak ref to an inventory:part (the thing being sold). Decremented
  -- from stock on fulfilment via the inventory adjust-stock action — never a FK.
  part_id     uuid,
  description text,
  qty         numeric not null default 1,
  unit_price  numeric,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index sales_order_items_order_idx on sales_order_items(order_id);
create index sales_order_items_part_idx on sales_order_items(part_id);
