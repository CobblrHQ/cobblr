-- Ship an order (#4051): the carrier and tracking number it went out with and
-- when, and the order's history, so an order says what happened to it rather
-- than only where it stands now. Additive.
--
-- The tracking number is the record's own, like a purchase's: core-shipments
-- names the carrier and follows the parcel from the number, and there is no
-- shipment table anywhere to keep in step with it.
alter table sales_orders add column if not exists carrier text;
alter table sales_orders add column if not exists tracking_number text;
alter table sales_orders add column if not exists shipped_at timestamptz;

-- One row per thing that happened to an order:
--   status   the status moved (from_status → to_status)
--   stock    parts left stock on a fulfil (detail: what shipped, complete?)
--   shipped  it went out (detail: carrier, tracking_number)
--   email    the customer was emailed (detail: to, message_id, log_id, status)
create table if not exists sales_order_history (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references sales_orders(id) on delete cascade,
  kind         text not null check (kind in ('status', 'stock', 'shipped', 'email')),
  from_status  text,
  to_status    text,
  detail       jsonb not null default '{}'::jsonb,
  by_user      uuid,
  created_at   timestamptz not null default now()
);
create index if not exists sales_order_history_order_idx on sales_order_history (order_id, created_at);
