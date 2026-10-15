alter table sales_orders add column paid_at timestamptz;

create function sales_payment_date() returns trigger language plpgsql as $$
begin
  if new.paid is not true then
    new.paid_at := null;
  elsif TG_OP = 'INSERT' then
    new.paid_at := now();
  elsif old.paid is not true then
    new.paid_at := now();
  else
    new.paid_at := old.paid_at;
  end if;
  return new;
end;
$$;
create trigger sales_payment_date before insert or update on sales_orders
for each row execute function sales_payment_date();

create table sales_document_counters (
  instance text not null,
  kind text not null check (kind in ('quote', 'invoice')),
  last_number integer not null default 0,
  primary key (instance, kind)
);
create table sales_order_documents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references sales_orders(id) on delete cascade,
  instance text not null default 'sales',
  kind text not null check (kind in ('quote', 'invoice')),
  number text not null,
  revision uuid not null default gen_random_uuid(),
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (order_id, kind),
  unique (instance, kind, number)
);
