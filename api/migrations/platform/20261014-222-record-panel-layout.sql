-- How a workspace arranges the panels on one kind of record (#6337): which
-- are hidden and in what order. Keyed by the collection kind when a record
-- has one, else its kind (platform-contract record-panel-layout.ts).
create table record_panel_layouts (
  org_id uuid not null references orgs(id) on delete cascade,
  entity_kind text not null,
  state jsonb not null default '{}'::jsonb,
  revision integer not null default 0,
  primary key (org_id, entity_kind)
);
