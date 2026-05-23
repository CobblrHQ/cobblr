-- M2 from docs/BACKLOG.md: public read surfaces.
--
-- The actual surface configs live in each tenant DB (in the
-- core-public-surfaces module's core_public_surfaces_surfaces
-- table). What goes in cobblr_meta is just the (token → org_id →
-- surface_id) index, so an unauthenticated GET /api/v1/public/:token
-- can route to the right tenant in one query.
--
-- Why the index lives at the meta layer: there's no slug in /public/
-- URLs — anyone with the token has to be routable. Scanning every
-- tenant DB for a matching token would scale poorly.
--
-- Soft-revoke: revoked_at fenced. Token lookups MUST filter
-- revoked_at is null + (expires_at is null or expires_at > now()).

create table public_surface_tokens (
  -- The token is the URL secret. Stored cleartext intentionally —
  -- it's already the only auth on the public read path, hashing
  -- buys no security but breaks lookups. Long randoms only.
  token         text primary key,
  org_id        uuid not null references orgs(id) on delete cascade,
  -- Module's surface id, lives in tenant DB. uuid stored as text
  -- to avoid the cross-DB type coupling.
  surface_id    text not null,
  enabled       boolean not null default true,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index public_surface_tokens_org_idx on public_surface_tokens(org_id);
