-- core-views — view definitions per tenant.
--
-- One row = one saved view (a filtered, sorted, formatted lens over
-- an entity kind). `entity_kind` is the registry id like
-- "inventory:part". `view_type` is the renderer ("list" today;
-- kanban / calendar / table land later). `config` is an opaque
-- JSON blob whose shape depends on view_type — the platform
-- validates at the contract level, the renderer interprets at the
-- web bundle.
--
-- Scope:
--   owner_user_id IS NULL  → workspace-shared view (visible to everyone in the org)
--   owner_user_id IS NOT NULL → private view (only that user sees it)
-- We don't enforce visibility at the SQL layer — the route checks
-- the JWT user against owner_user_id when filtering for "my views".

create extension if not exists "pgcrypto";

create table core_views_views (
  id              uuid primary key default gen_random_uuid(),
  entity_kind     text not null,
  name            text not null,
  view_type       text not null,
  config          jsonb not null default '{}'::jsonb,
  is_default      boolean not null default false,
  owner_user_id   uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index core_views_views_kind_idx on core_views_views(entity_kind);
create index core_views_views_owner_idx on core_views_views(owner_user_id);

-- Only ONE default per (entity_kind, owner_user_id) pair, including
-- the workspace-shared case (owner_user_id IS NULL). Partial unique
-- because NULL != NULL in unique constraints.
create unique index core_views_views_default_per_user_idx
  on core_views_views(entity_kind, owner_user_id)
  where is_default = true and owner_user_id is not null;
create unique index core_views_views_default_workspace_idx
  on core_views_views(entity_kind)
  where is_default = true and owner_user_id is null;
