-- One order, several parcels (#5351).
--
-- An order had one tracking number, so a store that ships an order in several
-- boxes (one per 10 kg filament bundle) could record the first and had nowhere
-- for the rest, and the first parcel's number made the whole order look in
-- transit. A shipment is one parcel of an order: its own tracking number, its
-- own carrier state and date, and the lines it carries. A line with no
-- shipment travels under the order's own tracking number, as every order did
-- before, so nothing already recorded changes meaning.
--
-- asked_state is the arrival ask's once-per-state stamp for this parcel, the
-- same rule purchases_arrival_asks.carrier_state keeps for a whole order;
-- received_at is when a person said this box turned up.
--
-- stock_withdrawn_at marks a line whose receive was taken back: a receipt
-- with no tracking number is filed as arrived (its lines received, their
-- stock added), and a shipping notice for that order later proves it was not
-- in hand. Its stock comes off again; when it really arrives the stock goes
-- back on and its cost, already counted once, is not counted again.
-- Additive.

create table if not exists purchases_order_shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references purchases_orders(id) on delete cascade,
  tracking_number text not null,
  shipment_state text,
  shipment_checked_at timestamptz,
  shipment_next_poll_at timestamptz,
  expected_arrival date,
  eta_source text,
  description text,
  asked_state text,
  tracking_added_by_user_id uuid,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, tracking_number)
);

create index if not exists purchases_order_shipments_order_idx on purchases_order_shipments(order_id);

alter table purchases_order_items
  add column if not exists shipment_id uuid references purchases_order_shipments(id) on delete set null;

alter table purchases_order_items
  add column if not exists stock_withdrawn_at timestamptz;
