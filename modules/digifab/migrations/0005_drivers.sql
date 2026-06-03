-- Installed drivers — user-installable machine-manager connectors, no
-- platform deploy. Built-ins (fdm_monster, mock) live in code; this table
-- holds the ones a workspace installs: a declarative HTTP manifest, or an
-- edge-adapter URL. A connection's `type` is the driver key — a built-in
-- key or a row's `key` here. See docs/modules/digifab-drivers.md.
create table digifab_drivers (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,                 -- driver key (e.g. "octoprint"); connection.type references this
  name        text not null,                 -- display name
  kind        text not null,                 -- "declarative" | "edge-adapter" (built-ins aren't stored here)
  spec        jsonb not null default '{}',   -- the manifest (declarative) or { adapterUrl } (edge-adapter)
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (key)
);
