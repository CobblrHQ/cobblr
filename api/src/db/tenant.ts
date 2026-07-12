// Per-tenant connection pool cache + Kysely factory. One Pool +
// Kysely instance per org id, opened lazily on first use, kept
// process-wide.
//
// At scale, this is where PgBouncer slots in: replace the per-tenant
// Pool with a single connection through PgBouncer that switches its
// authenticated role per request. For Phase 0 we just hold N pools.

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { env } from "../env.js";
import { meta } from "./meta.js";
import { decryptCreds } from "./crypto.js";
import type { TenantDB } from "./tenant-schema.js";

interface CachedTenant {
  pool: Pool;
  db: Kysely<TenantDB>;
}

// Cache the in-flight PROMISE, not the resolved value: two concurrent
// first-requests for the same tenant then share one open() instead of
// each constructing a Pool — otherwise the second cache.set() overwrites
// the first, orphaning its connections (a slow leak under load).
const cache = new Map<string, Promise<CachedTenant>>();

// Last time getTenantDb handed out this org's Kysely. A background sweep
// (recurrence scheduler / maintenance / scan-inbox calling releaseIdleDb)
// must NOT end a pool that was handed out moments ago: getTenantDb returns the
// Kysely, but the caller checks out a connection only when it runs its query —
// in that gap the pool looks "all idle" (totalCount === idleCount, no waiters),
// so the idle-guard alone would end it and the imminent query hits a dead pool
// ("Cannot use a pool after calling end on the pool" — a real 500, and the CI
// filament-upgrade flake). Requiring the pool to have been idle for a grace
// window before eviction — standard idle-*timeout* behaviour, not evict-on-sight
// — closes that gap (callers query within ms of getTenantDb).
const lastAccess = new Map<string, number>();
const RELEASE_GRACE_MS = 15_000;

// Upper bound on cached tenant pools. Each pool holds up to `max` connections
// (5), so total tenant connections stay ≈ MAX_TENANT_POOLS × 5. WITHOUT this the
// cache is unbounded: a workload that touches many orgs (the CI suite hits ~174
// pooled orgs across 8 forks) accumulates one pool per org — hundreds of
// connections — and exhausts Postgres ("remaining connection slots are reserved
// for non-replication superuser connections"). That surfaces as intermittent 503s
// and, because whichever test is mid-flight when the api starts refusing
// connections fails, as "random" test flakes on a DIFFERENT test each run. When
// the cache goes over the cap we release the least-recently-used IDLE pools (they
// reopen lazily on next access). Default 50 (≈250 conns) is safe under the CI
// box's max_connections=400 and never triggers on a small prod (few active orgs);
// tune via COBBLR_MAX_TENANT_POOLS where max_connections differs.
const MAX_TENANT_POOLS = Math.max(4, Number(process.env.COBBLR_MAX_TENANT_POOLS) || 50);

/** When the pool cache is over the cap, release the least-recently-used pools.
 *  Uses the same idle-guarded release as the background sweep, so a pool with a
 *  checked-out client or one handed out within the grace window is skipped (and
 *  reclaimed on a later call). Reopen is lazy on the next getTenantDb. */
function enforceTenantPoolCap(): void {
  const over = cache.size - MAX_TENANT_POOLS;
  if (over <= 0) return;
  const oldest = [...lastAccess.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, over);
  for (const [orgId] of oldest) void releaseIdleTenantPool(orgId);
}

interface TenantCredentials {
  user: string;
  password: string;
}

/** Pull host + port from the meta DB URL — every tenant DB lives on
 *  the same Postgres instance. The DB name + user + password come
 *  from the org row. */
function metaHostBits(): { host: string; port: number } {
  const url = new URL(env.DATABASE_URL);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
  };
}

async function openTenant(orgId: string): Promise<CachedTenant> {
  const org = await meta
    .selectFrom("orgs")
    .select(["db_name", "db_credentials_encrypted"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!org) throw new Error(`Org not found: ${orgId}`);
  if (!org.db_credentials_encrypted) {
    throw new Error(`Org ${orgId} has not been provisioned yet`);
  }

  const creds = JSON.parse(decryptCreds(org.db_credentials_encrypted)) as TenantCredentials;
  const { host, port } = metaHostBits();
  const pool = new Pool({
    host,
    port,
    database: org.db_name,
    user: creds.user,
    password: creds.password,
    // Per-tenant connection cap. Total tenant connections ≈ (live pools) × this.
    // Tunable so a high-parallelism env (CI: 8 vitest forks provisioning many
    // orgs at once) can shrink the FOOTPRINT rather than forever raising the
    // Postgres max_connections ceiling — a burst can transiently outrun the LRU
    // pool-cap eviction, so bounding per-pool conns is the durable lever. Default
    // 5 (prod); CI sets COBBLR_TENANT_POOL_MAX=3.
    max: Number(process.env.COBBLR_TENANT_POOL_MAX) || 5,
  });
  // Without an 'error' listener, a pg-pool idle-client error (e.g.
  // backend kills a connection during DROP DATABASE on this tenant,
  // or a transient network blip) becomes an unhandled 'error' event
  // and Node terminates the process. Tenants get DROPped during
  // org-delete; this listener is what keeps the api alive across that
  // path.
  pool.on("error", (err) => {
    console.error(
      `[tenant-pool ${orgId}] idle client error:`,
      (err as Error).message,
    );
  });
  const db = new Kysely<TenantDB>({ dialect: new PostgresDialect({ pool }) });
  return { pool, db };
}

export async function getTenantDb(orgId: string): Promise<Kysely<TenantDB>> {
  // Stamp BEFORE the await: the grace window must cover from the moment we
  // commit to handing out this pool, not from when the promise resolves.
  lastAccess.set(orgId, Date.now());
  let entry = cache.get(orgId);
  if (!entry) {
    entry = openTenant(orgId);
    cache.set(orgId, entry);
    // A failed open must not poison the cache forever — let the next
    // call retry (only evict if our promise is still the cached one).
    entry.catch(() => {
      if (cache.get(orgId) === entry) cache.delete(orgId);
    });
    // Bound the cache so total connections can't exhaust Postgres.
    enforceTenantPoolCap();
  }
  return (await entry).db;
}

/** Pool accessor for callers that need raw pg (e.g. migration runner).
 *  Lazily opens the pool by going through getTenantDb. */
export async function getTenantPool(orgId: string): Promise<Pool> {
  await getTenantDb(orgId);
  return (await cache.get(orgId)!).pool;
}

/** Runtime-safe pool release for background cross-tenant sweeps. Closes and
 *  uncaches this tenant's pool ONLY if it has no checked-out clients (every
 *  connection idle, none waiting) — so a job that ticks across every tenant
 *  doesn't accumulate one live pool per org, while a pool a real request is
 *  mid-flight on is left untouched. The pool reopens lazily on the next
 *  `getTenantDb`. No-op if not cached or if the open failed.
 *
 *  Unlike `evictTenantPool` (used pre-`listen` and on org-delete, where an
 *  unconditional `pool.end()` is fine), this one is callable while the API
 *  is serving traffic — hence the idle guard. The guard and the cache delete
 *  run with no `await` between them, so no checkout can sneak in for the
 *  pool we're about to end. */
export async function releaseIdleTenantPool(orgId: string): Promise<void> {
  const entry = cache.get(orgId);
  if (!entry) return;
  let pool: Pool;
  try {
    ({ pool } = await entry);
  } catch {
    return; // open failed — nothing to release (getTenantDb self-evicts)
  }
  // Snapshot + delete with no await gap: in-use → leave it for live traffic.
  if (cache.get(orgId) !== entry) return; // someone else churned it
  if (pool.totalCount !== pool.idleCount || pool.waitingCount > 0) return;
  // Recently handed out? A request may hold the Kysely ref but not have checked
  // out a connection yet (so the counts above look idle). Leave it; the next
  // sweep will reclaim it once it's been quiet for the grace window.
  if (Date.now() - (lastAccess.get(orgId) ?? 0) < RELEASE_GRACE_MS) return;
  cache.delete(orgId);
  lastAccess.delete(orgId);
  try {
    await pool.end();
  } catch {
    // Already ending, or a client raced the end — harmless; the cache entry
    // is gone, so the next access opens a fresh pool.
  }
}

/** For tenant deletion — also useful in tests to reset the pool when
 *  the underlying DB has been dropped/recreated. */
export async function evictTenantPool(orgId: string): Promise<void> {
  const entry = cache.get(orgId);
  if (!entry) return;
  cache.delete(orgId);
  lastAccess.delete(orgId);
  try {
    const { pool } = await entry;
    await pool.end();
  } catch {
    // open() failed — nothing to close.
  }
}
