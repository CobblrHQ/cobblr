-- M2 v0.2: per-surface view log. One row per public-page hit so the
-- module can render "X views in last 7 days" without needing the
-- platform event bus to be persistent. Insert-only, never updated.
--
-- Retention: not enforced at the SQL level. A future scheduled wire
-- can `DELETE WHERE viewed_at < now() - '90 days'::interval` if the
-- table grows beyond what a tenant cares about.

create table core_public_surfaces_views (
  id          uuid primary key default gen_random_uuid(),
  surface_id  uuid not null references core_public_surfaces_surfaces(id) on delete cascade,
  viewed_at   timestamptz not null default now(),
  -- Optional: stash User-Agent prefix + referrer host for crude
  -- "where are people coming from" rollups. Kept short; this isn't
  -- replacing GA. Nullable so the public route can opt out per-hit
  -- without breaking the insert.
  ua_hint     text,
  referer     text
);

create index core_public_surfaces_views_surface_time_idx
  on core_public_surfaces_views(surface_id, viewed_at desc);
