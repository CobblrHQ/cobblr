-- Following the parcels a shop sends: where each sent parcel is, when it was
-- last asked about and when to ask next, and when it was delivered. Plus the
-- module's settings, where "Follow parcels I send" lives (off until a person
-- turns it on). Additive; nothing existing changes.
alter table sales_orders add column if not exists shipment_state text;
alter table sales_orders add column if not exists shipment_checked_at timestamptz;
alter table sales_orders add column if not exists shipment_next_poll_at timestamptz;
alter table sales_orders add column if not exists delivered_at timestamptz;

create table if not exists sales_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- A delivered scan goes on the order's history too.
alter table sales_order_history drop constraint if exists sales_order_history_kind_check;
alter table sales_order_history add constraint sales_order_history_kind_check
  check (kind in ('status', 'stock', 'shipped', 'email', 'work_order', 'line', 'delivered'));
