alter table sales_orders add column if not exists paid boolean not null default false;
alter table sales_orders add column if not exists auto_closed_at timestamptz;
alter table sales_orders add column if not exists auto_close_undone boolean not null default false;

insert into sales_settings (key, value)
values ('close_delivered_orders', '{"on":true}'::jsonb)
on conflict (key) do nothing;
