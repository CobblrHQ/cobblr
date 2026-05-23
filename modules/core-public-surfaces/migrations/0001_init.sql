-- core-public-surfaces — per-tenant table of surface configs.
--
-- The token-to-org lookup index is in cobblr_meta (see platform
-- migration 20260515-016-public-surface-tokens.sql). This table is
-- the tenant-side detail: what does each surface point at, what's
-- the scope, what's the display config.
--
-- v0.1 supports scope_type='view' (point at a saved core-views view)
-- and scope_type='entity' (point at a single entity by kind+id).
-- A future v0.2 can add scope_type='collection' for ad-hoc
-- entity-list filters defined entirely on the surface.

create extension if not exists "pgcrypto";

create table core_public_surfaces_surfaces (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  -- Cleartext token — stored in cleartext intentionally since it's
  -- already the only auth on the public read path; hashing buys
  -- nothing and breaks the meta-side lookup. Generated server-side
  -- as 32 bytes of random urlsafe-b64.
  token         text not null,
  -- 'view'   → scope_id is a uuid of a core_views_views row
  -- 'entity' → scope_id is "<kind>:<entityId>" (the kind segment
  --             lets the public route look up via the resolver
  --             without first reading the entity to learn its kind)
  scope_type    text not null,
  scope_id      text not null,
  -- Theme, refresh interval, header/footer text, what fields to
  -- show — all renderer-side concerns. The platform doesn't
  -- interpret this; the public response just echoes it back.
  config        jsonb not null default '{}'::jsonb,
  enabled       boolean not null default true,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index core_public_surfaces_token_idx on core_public_surfaces_surfaces(token);
create index core_public_surfaces_scope_idx on core_public_surfaces_surfaces(scope_type, scope_id);
