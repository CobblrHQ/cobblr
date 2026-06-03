-- Marketplace v2 (docs/modules/marketplace.md §4):
-- installed_modules records what's in the running image, including
-- the operator-curated set of marketplace modules. Populated at
-- api boot by the loader iterating /app/modules/<name>/ and
-- reading each manifest.
--
-- Distinct from `org_modules` (per-workspace enable) and from
-- `bundles` (declarative data presets). This is the "what code can
-- run on this host" registry.

create table installed_modules (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  version         text not null,
  band            text not null,
  -- "image"      → baked into cobblr-core itself (foundational + stock).
  -- "registry"   → fetched from cobblrhq/registry at image-build via
  --                signed tarball.
  -- "manual"     → placed in /var/cobblr/modules/ by the operator
  --                outside the registry flow (rare; for dev).
  source          text not null check (source in ('image', 'registry', 'manual')),
  source_url      text,
  source_sha256   text,
  signed_by       text,
  manifest        jsonb not null,
  installed_at    timestamptz not null default now(),
  installed_by    uuid references users(id) on delete set null
);

create index installed_modules_band_idx on installed_modules(band);
