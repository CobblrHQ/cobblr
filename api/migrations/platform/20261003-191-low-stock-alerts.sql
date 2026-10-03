-- Existing workspaces stay off; new workspaces start with low-stock alerts.
alter table orgs add column low_stock_alerts boolean not null default false;
alter table orgs alter column low_stock_alerts set default true;

create table low_stock_alert_deliveries (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  notified_on date not null,
  primary key (org_id, user_id)
);
