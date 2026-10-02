-- The friend's edits, coming back (#4627 §2.4-2.6,
-- docs/design-decisions/share-spaces.md §8). Additive.
--
-- share_copy_base, on the share space's side: each copy as the mirror last
-- wrote it, read back from the copy, so a later difference is the friend's
-- own edit and nothing the mirror did.
create table if not exists share_copy_base (
  link_id uuid not null references share_links(id) on delete cascade,
  origin_kind text not null,
  origin_id text not null,
  copy_kind text not null,
  copy_id text not null,
  fields jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (link_id, origin_kind, origin_id)
);
create index if not exists share_copy_base_copy on share_copy_base (link_id, copy_id);

-- share_suggestions, on the owner's side: one field of one record the friend
-- changed. Applied at once on a Direct share (kept so it can be undone),
-- pending on a Suggest share, and a conflict when the owner changed the
-- same field since it was copied.
create table if not exists share_suggestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  link_id uuid not null references share_links(id) on delete cascade,
  entity_kind text not null,
  entity_id text not null,
  field text not null,
  in_metadata boolean not null default false,
  base jsonb,
  proposed jsonb,
  owner_before jsonb,
  status text not null default 'pending',
  by_name text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid
);
create index if not exists share_suggestions_record on share_suggestions (org_id, entity_kind, entity_id, status);
create index if not exists share_suggestions_link on share_suggestions (link_id, status, created_at desc);

-- When the share space's side should next look for the friend's edits.
alter table share_links add column if not exists edits_due_at timestamptz;
