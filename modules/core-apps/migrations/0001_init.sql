-- core-apps — custom worker apps per tenant (H1, Tier A).
--
-- One row = one WorkspaceApp: a structured, declarative app a worker
-- (member) opens in the portal. `pages` is an ordered list of pages,
-- each an ordered list of blocks (view / record / action / form /
-- stat / markdown / scan) — see modules/core-apps/src/api/apps.ts for
-- the validated shape. The App Player (web) renders it; every block
-- still resolves through the kernel's capability + field-read-scope
-- (H2) boundary, so the app can't show or do anything the member's
-- capabilities don't already allow.
--
-- `visible_capability` gates who sees the app in their portal nav:
--   NULL                → any member of the workspace
--   "<module>:<action>" → only members who hold that capability
--                          (owner/admin implicitly hold everything)
--
-- This is the structured tier. The sandboxed-custom-frontend tier
-- (isolated origin + capability-scoped token) is a separate, later
-- surface — see docs/modules/custom-app-layer.md.

create extension if not exists "pgcrypto";

create table core_apps_apps (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null,
  name               text not null,
  icon               text,
  visible_capability text,
  pages              jsonb not null default '[]'::jsonb,
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (slug)
);

create index core_apps_apps_slug_idx on core_apps_apps(slug);
