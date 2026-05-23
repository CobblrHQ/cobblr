-- M1 from docs/BACKLOG.md: cross-workspace data sharing.
--
-- A user opts source-workspace → target-workspace read access for
-- specific entity_kinds. When the target reads via the platform's
-- list resolver, results union source's matching kind. Workspaces
-- otherwise stay isolated — there's no cross-tenant FK, no write
-- path across, and writes always land in the source's own tenant DB.
--
-- Status machine:
--   pending  - source initiated; target hasn't accepted yet
--   active   - both sides agree; reads union
--   revoked  - either side cancelled; reads return to isolated
--
-- When source and target are owned by the same user, the route
-- auto-flips to 'active' on create — no roundtrip needed.

create table workspace_links (
  id              uuid primary key default gen_random_uuid(),
  source_org_id   uuid not null references orgs(id) on delete cascade,
  target_org_id   uuid not null references orgs(id) on delete cascade,
  -- Array of entity_kind ids ('inventory:part', 'core-tags:tag') that
  -- the source exposes to the target. Updates require resubmit; no
  -- in-place edit (keeps the audit trail clean).
  kinds           text[] not null,
  status          text not null default 'pending',
  created_by      uuid not null references users(id),
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  -- One (source, target) pair active at a time. Re-pending after a
  -- revoke is fine.
  check (source_org_id <> target_org_id),
  check (status in ('pending', 'active', 'revoked'))
);

create index workspace_links_source_idx
  on workspace_links(source_org_id, status);
create index workspace_links_target_idx
  on workspace_links(target_org_id, status);

-- Prevent multiple active links for the same (source, target) pair.
create unique index workspace_links_active_pair_idx
  on workspace_links(source_org_id, target_org_id)
  where status = 'active';
