-- Purchasing depth: vendor management. A vendor was free text on each order;
-- this makes it a managed entity so it's reusable, dedupable, and lets you see
-- "all orders from McMaster" + spend-by-vendor. Orders gain a nullable
-- vendor_id; the legacy `vendor` text column stays (dual-written from the
-- vendor's name) so cross-module readers + old rows keep working.
--
-- manual recovery if this fails partway:
--   ALTER TABLE purchases_orders DROP COLUMN vendor_id;
--   DROP TABLE purchases_vendors;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0003_vendors';

create table purchases_vendors (
  id              uuid primary key default gen_random_uuid(),
  instance        text not null default 'purchases',
  name            text not null,
  website         text,
  account_number  text,
  contact         text,
  lead_time_days  integer,
  notes           text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index purchases_vendors_instance_idx on purchases_vendors(instance);
create index purchases_vendors_name_idx on purchases_vendors(instance, lower(name));

alter table purchases_orders
  add column vendor_id uuid references purchases_vendors(id) on delete set null;
create index purchases_orders_vendor_idx on purchases_orders(vendor_id);
