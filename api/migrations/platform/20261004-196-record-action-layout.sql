alter table entity_actions add column action_group text;
alter table entity_actions add column is_primary boolean not null default false;

create table record_action_layouts (
  org_id uuid not null references orgs(id) on delete cascade,
  entity_kind text not null,
  state jsonb not null default '{}'::jsonb,
  revision integer not null default 0,
  primary key (org_id, entity_kind)
);

create table record_action_pins (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  entity_kind text not null,
  state jsonb not null default '{}'::jsonb,
  primary key (org_id, user_id, entity_kind)
);
