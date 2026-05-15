-- Purchases module — orders + order_items + cost-rollup links.
--
-- Models the "I bought stuff from a vendor" workflow. An order has
-- many items; each item optionally points at an inventory:part for
-- stock-receipt semantics, AND optionally has polymorphic
-- consumed_by_* pointers so a finished item can be attributed to
-- whatever consumed it (e.g. a printer or a mod in the workshop
-- module). All cross-module pointers are weak references (no FK).

create table purchases_orders (
  id                uuid primary key default gen_random_uuid(),
  vendor            text,
  order_number      text,
  url               text,
  ordered_at        date,
  expected_arrival  date,
  arrived_at        date,
  status            text not null
    check (status in ('planned', 'ordered', 'in-transit', 'arrived', 'cancelled')),
  total_cost        numeric,
  shipping_cost     numeric,
  tracking_number   text,
  notes             text,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table purchases_order_items (
  id                       uuid primary key default gen_random_uuid(),
  order_id                 uuid not null references purchases_orders(id) on delete cascade,
  -- Optional FK to an inventory:part. Stored as the tenant-DB uuid;
  -- not enforced as a real FK because cross-module FKs are forbidden
  -- (modules talk through the platform).
  part_id                  uuid,
  description              text,
  qty                      numeric not null,
  unit_cost                numeric,
  -- Cost-rollup: who consumed this item? Polymorphic — module name
  -- + entity type + entity id, same shape as projects_task_dependencies.
  consumed_by_module       text,
  consumed_by_entity_type  text,
  consumed_by_entity_id    uuid,
  received_at              timestamptz,
  metadata                 jsonb not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index purchases_order_items_order_idx on purchases_order_items(order_id);
create index purchases_order_items_part_idx on purchases_order_items(part_id);
create index purchases_orders_status_idx on purchases_orders(status);
