-- Who works at a station (#8845): a tablet a team shares asks "Who's
-- working?", and every row it writes is recorded to the member picked, not
-- to the owner or admin who approved the tablet. One row per station with a
-- crew; none while nobody has named one, and such a station acts as its
-- approver as before. A member's own station PIN is kept per workspace, only
-- its hash. Additive.
create table if not exists station_crews (
  org_id uuid not null references orgs(id) on delete cascade,
  address text not null,
  user_ids uuid[] not null default '{}',
  pin_required boolean not null default false,
  idle_minutes integer not null default 10,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, address)
);

create table if not exists station_member_pins (
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  pin_hash text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
