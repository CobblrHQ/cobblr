-- An offer to reshape a kind's fields, made once and answered once (#4518):
-- "You buy from Detroit Axle through several places. Track sellers as their
-- own field?" Offered once per workspace and kind; a no is never asked again
-- for that kind (the field's settings still offer it). Additive.
create table if not exists field_upgrade_offers (
  org_id uuid not null references orgs(id) on delete cascade,
  entity_kind text not null,
  offer text not null,
  state text not null check (state in ('offered', 'declined', 'accepted')),
  at timestamptz not null default now(),
  primary key (org_id, entity_kind, offer)
);
