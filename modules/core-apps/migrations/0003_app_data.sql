-- core-apps — per-app key/value store for Tier-B custom apps.
--
-- A sandboxed custom app has no storage of its own (opaque-origin iframe,
-- no token, no localStorage it can trust). This gives it a small, app-scoped
-- JSON scratchpad — written ONLY through the capability-gated bridge
-- (cobblr.appSave / cobblr.appLoad), and only by members who can open the app.
-- It is deliberately NOT arbitrary entity write access: a custom app persists
-- its OWN data (e.g. the Outfit Planner's saved looks), never your real
-- entities. Workspace-scoped (one bag per app per workspace; tenant DB is
-- already per-org).

create table core_apps_app_data (
  id          uuid primary key default gen_random_uuid(),
  app_slug    text not null,
  key         text not null,
  value       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (app_slug, key)
);

create index core_apps_app_data_app_idx on core_apps_app_data(app_slug);
