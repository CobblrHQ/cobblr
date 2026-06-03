-- S2 from 2026-05-25-audit.md: custom roles.
--
-- Workspace admins define named roles ("Sorter", "Buyer") that
-- bundle multiple per-action capabilities. A user can be assigned
-- one stock role (owner/admin/member/guest) AND any number of
-- custom roles. Capability check walks: stock-role default → custom
-- role bundles → per-user grant.
--
-- Stock roles are unchanged. Custom roles are additive.
--
-- See docs/modules/member-portal-and-permissions.md §7
-- (deferred → now implemented).

create table workspace_roles (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  name            text not null,
  description     text,
  created_at      timestamptz not null default now(),
  created_by      uuid references users(id) on delete set null,
  -- (org_id, name) is the natural key — two custom roles can't have
  -- the same name within a workspace, but the same name CAN appear
  -- in different workspaces.
  unique (org_id, name)
);

create table workspace_role_capabilities (
  role_id     uuid not null references workspace_roles(id) on delete cascade,
  action_id   text not null,
  primary key (role_id, action_id)
);

create index workspace_role_capabilities_action_idx
  on workspace_role_capabilities(action_id);

create table workspace_role_assignments (
  org_id      uuid not null references orgs(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role_id     uuid not null references workspace_roles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  assigned_by uuid references users(id) on delete set null,
  primary key (org_id, user_id, role_id)
);

create index workspace_role_assignments_user_idx
  on workspace_role_assignments(org_id, user_id);
