-- Member portal + per-action capability grants
-- See docs/modules/member-portal-and-permissions.md
--
-- Two pieces:
--   1. portal_config jsonb on orgs — branding + pinned views for the
--      slimmed-down "member portal" front-end shell.
--   2. workspace_capability_grants — explicit per-(user, action)
--      grants so a `member` can be allowed specific verbs
--      (purchases:receive-order, inventory:create-part) without
--      escalating to `admin`.
--
-- Existing behavior is preserved: action handlers without an explicit
-- requireCapability() call still gate by role as before. Capabilities
-- are opt-in per action; the manifest declares `portal_grantable: true`.

alter table orgs
  add column if not exists portal_config jsonb
    not null default '{"pinned_views":[]}'::jsonb;

create table if not exists workspace_capability_grants (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  action_id  text not null,
  granted_at timestamptz not null default now(),
  granted_by uuid references users(id) on delete set null,
  unique (org_id, user_id, action_id)
);

create index if not exists workspace_capability_grants_user_idx
  on workspace_capability_grants(org_id, user_id);
create index if not exists workspace_capability_grants_action_idx
  on workspace_capability_grants(org_id, action_id);
