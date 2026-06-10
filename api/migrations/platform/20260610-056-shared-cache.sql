-- Cross-tenant key/value cache (platform.sharedCache). Holds data that is the
-- SAME for every workspace and is NOT tenant-private — the first use is the
-- barcode→product cache, so a UPC is resolved ONCE across the whole host
-- instead of re-spending the shared (one-egress-IP) upcitemdb free-tier quota
-- per tenant. Never store tenant-identifying data here.
-- See docs/history/2026-06-10-prelaunch-audit.md follow-ups.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS shared_cache;
--   DELETE FROM migrations WHERE name = '20260610-056-shared-cache.sql';

create table if not exists shared_cache (
  namespace  text        not null,
  key        text        not null,
  value      jsonb       not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (namespace, key)
);

-- Partial index so a sweep of expired rows is cheap.
create index if not exists shared_cache_expires_idx
  on shared_cache (expires_at) where expires_at is not null;
