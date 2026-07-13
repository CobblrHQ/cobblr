-- core_scan_decode_cache — the identifier-decoder registry's shared cache.
--
-- Generic across decoders (keyed by decoder_id + code), so the VIN decoder and
-- any future decoder (ISBN, boat HIN, appliance model) reuse one table. Mirrors
-- the barcode-cache discipline EXACTLY: a decoded identifier → attributes
-- mapping is effectively immutable, so a `hit`/`partial` is cached forever
-- (expires_at null) and a durable `miss` gets a TTL (expires_at set), but an
-- `unavailable` (vPIC/provider timeout or outage) is NEVER written — a throttle
-- is not a durable miss (the same invariant that keeps a rate-limited barcode
-- scan from poisoning the cache with a permanent miss for a real product).
--
-- See docs/design-decisions/vin-decode.md §6 and services/identifier-registry.ts.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_scan_decode_cache;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0011_decode_cache';

create table core_scan_decode_cache (
  decoder_id text        not null,          -- "vin", later "isbn", "hin"
  code       text        not null,          -- the normalized identifier
  outcome    text        not null,          -- 'hit' | 'partial' | 'miss' (never 'unavailable')
  fields     jsonb       not null default '{}'::jsonb,
  provenance text,
  note       text,
  raw        jsonb,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz,                    -- null = never (hit/partial); set = durable miss TTL
  primary key (decoder_id, code)
);
