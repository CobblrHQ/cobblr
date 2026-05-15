-- Per-org module enablement. Row exists ⇔ module is installed for
-- that org. last_migration tracks the highest-numbered migration
-- applied to the tenant DB so future re-runs are idempotent and
-- upgrades can replay only what's new.

create table org_modules (
  org_id          uuid not null references orgs(id) on delete cascade,
  module_name     text not null,
  version         text not null,
  enabled_at      timestamptz not null default now(),
  last_migration  text,
  primary key (org_id, module_name)
);

create index org_modules_module_idx on org_modules(module_name);
