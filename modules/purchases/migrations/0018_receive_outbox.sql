create table purchases_receive_outbox (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references purchases_orders(id) on delete cascade,
  line_id uuid not null,
  payload jsonb not null,
  completed_recipients jsonb not null default '[]'::jsonb,
  completed_at timestamptz,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index purchases_receive_outbox_pending_idx on purchases_receive_outbox(order_id, next_attempt_at) where completed_at is null;
create index purchases_receive_outbox_retry_idx on purchases_receive_outbox(next_attempt_at, id) where completed_at is null;
