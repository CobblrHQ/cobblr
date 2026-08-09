-- Claim attribution: "I'm getting this" on a shared list, so two people in the
-- same household don't both come home with milk.
--
-- The claimer's NAME is snapshotted alongside the id on purpose. A list line is
-- a throwaway record read at a glance in a store aisle; resolving a uuid to a
-- member on every render would mean a cross-module lookup from a module that
-- owns no membership data, and a line claimed by someone who later left the
-- workspace would go anonymous. The snapshot keeps rendering local and honest.

alter table lists_items
  add column claimed_by      uuid,
  add column claimed_by_name text,
  add column claimed_at      timestamptz;

-- Only open lines are ever filtered by claim, so keep the index partial.
create index lists_items_claimed_idx on lists_items(list_id) where claimed_by is not null;
