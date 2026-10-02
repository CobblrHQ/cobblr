-- What a share's mirror last sent the other side (#4627 §2,
-- docs/design-decisions/share-spaces.md §7). Additive.
--
-- One row per record the owner's side mirrored over a link: the digest of
-- what was sent, so a pass sends only what changed, and a record that left
-- the scope is known and removed. A row whose entity_kind starts with
-- "shape:" is a collection's shape (its fields), sent before its records.
create table if not exists share_mirror_state (
  link_id uuid not null references share_links(id) on delete cascade,
  entity_kind text not null,
  entity_id text not null,
  digest text not null,
  photo_digest text,
  sent_at timestamptz not null default now(),
  primary key (link_id, entity_kind, entity_id)
);

-- When a link's mirror should next run (a change in its workspace sets it),
-- and when it last finished.
alter table share_links add column if not exists mirror_due_at timestamptz;
alter table share_links add column if not exists mirrored_at timestamptz;
