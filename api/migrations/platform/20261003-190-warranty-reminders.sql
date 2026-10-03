-- Existing workspaces stay off; only workspaces born after this opt in.
alter table orgs add column warranty_reminders boolean not null default false;
alter table orgs alter column warranty_reminders set default true;

create table warranty_reminder_deliveries (
  org_id uuid not null references orgs(id) on delete cascade,
  event_id text not null,
  user_id uuid not null references users(id) on delete cascade,
  notified_at timestamptz not null default now(),
  primary key (org_id, event_id, user_id)
);
