-- M1 v0.5: per-link role overrides. NULL = no restriction (every
-- member of the target workspace can read the share, the default
-- v0.1 behavior). When set, only target-workspace members whose
-- role meets-or-exceeds the threshold can read.
--
-- Role hierarchy: owner > admin > member > guest.

alter table workspace_links
  add column min_target_role text;

-- Index includes min_target_role so cross-workspace reads can
-- filter without rebuilding the existing partial.
create index workspace_links_target_role_idx
  on workspace_links(target_org_id, min_target_role)
  where status = 'active';
