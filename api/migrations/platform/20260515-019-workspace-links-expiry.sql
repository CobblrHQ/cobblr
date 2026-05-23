-- M1 v0.2: optional expiry on workspace_links. NULL = never expires
-- (back-compat with v0.1 rows). At read-time we treat a link with
-- expires_at <= now() as inactive — no scheduled sweep needed.

alter table workspace_links
  add column expires_at timestamptz;

-- Filter index for active links reachable by target_org_id; covers
-- the entities.list union path's most common scan. We DON'T put
-- `expires_at > now()` in the WHERE — partial-index predicates can't
-- reference volatile functions like now(), and even if they could
-- the snapshot would be wrong by query time. Expiry is filtered at
-- read time in the union query; the index just narrows status.
create index workspace_links_target_active_idx
  on workspace_links(target_org_id, expires_at)
  where status = 'active';
