-- Things handed over between the two sides of a share (#4627 §3,
-- docs/design-decisions/share-spaces.md §6). Additive.
--
-- One row per thing, on each side: the giver's ('out') and the receiver's
-- ('in', carrying the giver's id as peer_offer_id). The giver's id is the
-- offer's name in every change between them. `source` is what was offered on
-- the giver's side (a record, or a scan inbox item), `landed` where it arrived
-- on the receiver's (an inbox item, then the record it was filed as).
create table if not exists share_offers (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references share_links(id) on delete cascade,
  direction text not null check (direction in ('out', 'in')),
  peer_offer_id uuid,
  batch text not null,
  title text not null,
  status text not null default 'offered' check (status in ('offered', 'maybe', 'taken', 'passed', 'withdrawn', 'returned')),
  source jsonb,
  landed jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  taken_at timestamptz
);
create index if not exists share_offers_link_idx on share_offers (link_id, created_at desc);
create unique index if not exists share_offers_peer_idx on share_offers (link_id, peer_offer_id) where peer_offer_id is not null;
