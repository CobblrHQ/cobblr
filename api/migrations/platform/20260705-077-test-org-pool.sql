-- TEST-ONLY: a pool of pre-provisioned orgs the integration suite checks out
-- instead of provisioning from scratch (~63% of CI runtime). This table only
-- ever has rows in CI / the test rig — the bake that fills it is gated on
-- COBBLR_TEST_ORG_POOL, which prod never sets. The table itself is harmless in
-- prod (always empty). See api/src/db/test-org-pool.ts.
create table if not exists test_org_pool (
  org_id        uuid primary key references orgs(id) on delete cascade,
  slug          text not null,
  owner_user_id uuid not null references users(id) on delete cascade,
  status        text not null default 'available',  -- 'available' | 'taken'
  baked_at      timestamptz not null default now()
);
-- Checkout claims the oldest available row under SKIP LOCKED; index the hot path.
create index if not exists test_org_pool_available_idx
  on test_org_pool (baked_at) where status = 'available';
