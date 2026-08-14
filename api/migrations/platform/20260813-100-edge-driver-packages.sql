-- Which driver packages a workspace's edge bridges should be running.
--
-- The DESIRED state. The bridge polls it and converges; nothing here is a
-- record of what is actually installed, which the bridge reports separately so
-- declared-versus-actual stays visible.
--
-- Cobblr is a conduit, not a store: `source` is where the bytes come from and
-- `sha256` is what they must hash to. The artifact itself is never held, so
-- there is no bytes column here and there should not be one.

create table edge_driver_packages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references orgs(id) on delete cascade,
  -- Referenced by an instance's `driver:` in bridge config, and it becomes a
  -- FILENAME on the bridge, hence the shape constraint.
  kind        text not null check (kind ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  -- Pinned, never "latest": a bridge changes behaviour when somebody decides
  -- it should, not when an upstream publishes.
  version     text not null,
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  source      text not null,
  -- Null = every bridge in the workspace. Set = only that one, for a workspace
  -- running more than one site (same key the relay already uses).
  bridge_id   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One version of a kind per bridge scope; asking for two is a config error
-- rather than something to resolve at fetch time.
create unique index edge_driver_packages_scope
  on edge_driver_packages (org_id, kind, coalesce(bridge_id, ''));
