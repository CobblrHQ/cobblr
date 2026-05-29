-- Nav-builder #2 — user-defined navbar headings (org-wide). A workspace
-- groups nav entries (modules + instances) under custom headings — a
-- "Motorcycle" heading holding "Motorcycle Parts" (inventory instance)
-- + "Motorcycles" (asset instance), across modules. The nav renders
-- each heading as a dropdown (reusing the existing ModuleGroupChip).
--
-- Org-wide: this is the workspace's information architecture, like
-- module instances + entity_kind_overrides. The per-user hide/reorder
-- (nav-order.ts, localStorage) still layers on top client-side.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS workspace_nav_heading_members;
--   DROP TABLE IF EXISTS workspace_nav_headings;
--   DELETE FROM migrations WHERE name = '20260529-036-nav-headings.sql';

create extension if not exists "pgcrypto";

create table workspace_nav_headings (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  name        text not null,
  icon        text,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index workspace_nav_headings_org_idx
  on workspace_nav_headings(org_id);

create table workspace_nav_heading_members (
  id          uuid primary key default gen_random_uuid(),
  heading_id  uuid not null references workspace_nav_headings(id) on delete cascade,
  org_id      uuid not null references orgs(id) on delete cascade,
  -- 'module'   → target_id is a module name (e.g. "inventory")
  -- 'instance' → target_id is an instance slug (e.g. "screws")
  target_kind text not null,
  target_id   text not null,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  -- An entry belongs to at most one heading per workspace.
  unique (org_id, target_kind, target_id)
);
create index workspace_nav_heading_members_heading_idx
  on workspace_nav_heading_members(heading_id);
