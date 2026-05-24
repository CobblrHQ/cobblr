-- Module instances — multiple installs of one module per workspace.
--
-- A workspace can install the inventory module multiple times under
-- different instance names ("screws", "printer-parts", "electrical").
-- Each instance is a separate top-level entity with its own routes,
-- custom fields, saved views, and presentation. The underlying tables
-- (inventory_parts, etc.) gain an `instance` column distinguishing
-- rows; this table tracks the (workspace, module, instance) triples
-- that exist.
--
-- The implicit default install of a module gets an instance row with
-- instance_name = module_name and is_default = true. User-created
-- instances are subsequent rows with chosen names.
--
-- See docs/design-decisions/instances.md for the full design.

create table workspace_module_instances (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete cascade,
  module_name     text not null,
  instance_name   text not null,
  display_name    text not null,
  -- True for the implicit default created on enableModuleForOrg. The
  -- default cannot be deleted independently — it goes away with the
  -- whole module on disable.
  is_default      boolean not null default false,
  config          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (org_id, module_name, instance_name)
);

create index workspace_module_instances_org_idx
  on workspace_module_instances(org_id);
create index workspace_module_instances_module_idx
  on workspace_module_instances(module_name);

-- Slug validity: lowercase letters, digits, hyphens; can't start
-- with hyphen. Same shape as bundle external_id slugs.
alter table workspace_module_instances
  add constraint workspace_module_instances_slug_format
  check (instance_name ~ '^[a-z0-9][a-z0-9-]*$');

-- Backfill default instances for every existing (org, module) pair.
-- The instance_name = module_name pattern means existing routes /
-- field defs / saved views keep working as the "default instance"
-- without any client-side changes.
insert into workspace_module_instances (org_id, module_name, instance_name, display_name, is_default)
select
  om.org_id,
  om.module_name,
  om.module_name as instance_name,
  -- Title-cased fallback for display_name — modules with a
  -- displayName in their manifest get that on next boot via the
  -- platform's registry-sync.
  initcap(replace(om.module_name, '-', ' ')) as display_name,
  true as is_default
from org_modules om
on conflict do nothing;

-- ──────────────── entity_kind_overrides ──────────────────────────
--
-- The unified workspace presentation registry. Both lens-promotion
-- and instance creation write rows here; the nav renderer +
-- breadcrumb + heading + search-chip all read from it.
--
-- target_kind discriminates what the row is overriding:
--   'entity_kind' — the kind ID itself (e.g. "assets:asset")
--   'instance'    — a module instance row (e.g. "inventory:screws")
--   'bundle'      — a bundle (e.g. "cobblr.community.cars")
--
-- Workspace edits trump bundle defaults; re-install doesn't clobber.

create table entity_kind_overrides (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references orgs(id) on delete cascade,
  target_kind           text not null,
  target_id             text not null,
  display_label         text,
  display_label_plural  text,
  icon                  text,
  hidden                boolean not null default false,
  nav_order             integer,
  config                jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (org_id, target_kind, target_id),
  check (target_kind in ('entity_kind', 'instance', 'bundle'))
);

create index entity_kind_overrides_org_idx
  on entity_kind_overrides(org_id);
