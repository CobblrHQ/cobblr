alter table orgs add column if not exists main_currency text not null default 'USD' check (main_currency ~ '^[A-Z]{3}$');
create table if not exists exchange_rates (
  rate_date date primary key,
  rates jsonb not null,
  fetched_at timestamptz not null default now()
);
create table if not exists exchange_rate_fetches (
  id text primary key,
  fetched_at timestamptz not null
);
