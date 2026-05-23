-- Add an explicit `pinned` flag so the dashboard can render the
-- pinned views (instead of arbitrarily picking the first 2 shared
-- views). Default false; users opt in per view.

alter table core_views_views
  add column pinned boolean not null default false;

-- Partial index so the dashboard's "what's pinned" query stays
-- O(pinned-count) instead of O(all-views).
create index core_views_views_pinned_idx
  on core_views_views(entity_kind)
  where pinned = true;
