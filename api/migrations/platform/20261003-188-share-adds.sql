-- The friend's side of a share learns more, and can add (#4627 §2.2, §2.8,
-- docs/design-decisions/share-spaces.md §11). Additive.
--
-- share_copy_base.owner_changed: on a copy whose field the friend edited and
-- the owner changed since, what the owner's says now, so the copy can say
-- "changed by Sam since you edited".
alter table share_copy_base add column if not exists owner_changed jsonb not null default '{}'::jsonb;

-- share_added, on the share side: records the friend made in the share
-- space that went to the owner as additions, so each goes once.
create table if not exists share_added (
  link_id uuid not null references share_links(id) on delete cascade,
  copy_kind text not null,
  copy_id text not null,
  sent_at timestamptz not null default now(),
  primary key (link_id, copy_id)
);

-- share_additions, on the owner's side: what the friend added, waiting for
-- the owner to take it into their own collection or leave it.
create table if not exists share_additions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  link_id uuid not null references share_links(id) on delete cascade,
  peer_copy_id text not null,
  entity_kind text not null,
  title text not null,
  fields jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  by_name text,
  status text not null default 'pending',
  taken_id text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (link_id, peer_copy_id)
);
create index if not exists share_additions_open on share_additions (org_id, status);
