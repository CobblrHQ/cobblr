-- An order's own page at its store (#5461).
--
-- A Shopify store's order email has a "View order" button whose link signs
-- the buyer in and opens a page listing each line with its own carrier and
-- tracking number. That link is kept here, sealed with the workspace's
-- credential key (never readable from a row, never returned by any route),
-- and read on a schedule until every line is delivered.
--
-- order_id is null until the order exists: the email that carried the link
-- may be filed before Purchases makes the order, so the row waits on the
-- order number and store, and the sweep joins them.
--
-- state: waiting (some line has no tracking number yet), following (every
-- line has one, not all delivered), done, expired (the link no longer signs
-- in), redacted (it opens only the guest view, without tracking) or
-- unsupported (not a store page this reads). next_read_at null means never
-- again. shipped_lines is how many lines the page said had left, which the
-- guest view still tells.
-- Additive.

create table if not exists purchases_order_pages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references purchases_orders(id) on delete cascade,
  order_number text,
  store_host text not null,
  link_sealed text not null,
  state text not null default 'waiting',
  next_read_at timestamptz,
  last_read_at timestamptz,
  last_outcome text,
  refusals integer not null default 0,
  shipped_lines integer,
  captured_by_user_id uuid,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists purchases_order_pages_order_idx
  on purchases_order_pages(order_id) where order_id is not null;
create unique index if not exists purchases_order_pages_pending_idx
  on purchases_order_pages(store_host, order_number) where order_id is null;
create index if not exists purchases_order_pages_due_idx
  on purchases_order_pages(next_read_at) where next_read_at is not null;
