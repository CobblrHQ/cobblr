-- bundle_resource_claims — provenance/refcount for what each bundle (or the user)
-- "owns", so a bundle uninstall can safely disable a module / delete an instance
-- ONLY when nothing else still claims it.
--
-- Without this, uninstall left the instances a bundle created orphaned (lingering
-- top-level nav) and the modules it enabled still on. You can't decide whether
-- disabling a module is safe from current state alone — "another bundle needs it",
-- "the user enabled it", and "only this bundle needed it" look identical. This
-- ledger records the difference. See docs/design-decisions/bundle-uninstall-refcount.md.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS bundle_resource_claims;
--   DELETE FROM _prisma_migrations WHERE migration_name = '20260621-068-bundle-resource-claims';

create table bundle_resource_claims (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete cascade,
  -- who claims this resource: a bundle's external_id, or the literal 'user'
  -- (manual enable). A 'user' claim pins a module forever.
  source        text not null,
  resource_type text not null check (resource_type in ('module','instance')),
  -- module_name (for 'module') or instance_name (for 'instance')
  resource_key  text not null,
  created_at    timestamptz not null default now(),
  unique (org_id, source, resource_type, resource_key)
);

-- the refcount lookup: "how many sources still claim this resource?"
create index bundle_resource_claims_lookup
  on bundle_resource_claims (org_id, resource_type, resource_key);
