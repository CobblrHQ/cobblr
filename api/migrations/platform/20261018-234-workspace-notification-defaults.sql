-- How a workspace's members hear its urgent and high events until they choose
-- for themselves (#6909): one default channel per priority, set by an owner or
-- admin. No row is the in-app bell only, as before. A member's own channel
-- choice in the workspace always wins, and turning a channel off stays off.
create table if not exists workspace_notification_defaults (
  org_id     uuid not null references orgs(id) on delete cascade,
  priority   text not null check (priority in ('urgent', 'high')),
  channel    text not null check (channel in ('email', 'discord_dm', 'browser_push')),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, priority)
);
