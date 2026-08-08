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
import { mayFastClose } from "./pool-release-rule.js";

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
const RELEASE_GRACE_MS = Number(process.env.COBBLR_POOL_RELEASE_GRACE_MS) || 15_000;

// Monotonic per-org access counter. `lastAccess` (wall time) can collide within
// a millisecond, so identity questions — "has anyone touched this pool since MY
// access?" — use this instead. That question is what lets a cross-tenant sweep
// release the pool it just used IMMEDIATELY: the grace window exists to protect
// a caller who holds a fresh Kysely ref but hasn't checked out a connection
// yet, and any such caller would have bumped the seq.
const accessSeq = new Map<string, number>();
let seqCounter = 0;

// One pending deferred-release timer per org. Without this, a release attempt
// that lands inside the grace window was a SILENT NO-OP — and since a sweep's
// own getTenantDb is what stamps lastAccess, every sweep's release call fell in
// the window and released nothing. 251 tenants × an hourly sweep = hourly
// connection-slot exhaustion (found on staging, 2026-08-07). Deferring the
// release past the window keeps the guarantee: touched pools stay, quiet pools
// close.
const pendingRelease = new Map<string, NodeJS.Timeout>();

// How many times THIS pool generation has been handed out (reset when the pool
// is opened). The seq answers "did anyone access after me?"; it cannot answer
// "was anyone already using it before me?" — and that second question is the
// one that matters, because a caller handed the Kysely BEFORE a sweep has not
// checked out a connection yet and so looks perfectly idle to every guard here.
// A sweep that opened the pool itself is the only caller that can prove nobody
// else is mid-flight on it.
const handouts = new Map<string, number>();

// The fast-close rule lives in pool-release-rule.ts (pure + unit-tested).

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
  // The Kysely handed to callers talks to the pool through this shim rather than
  // holding the Pool directly. If the pool it was built on has been ended (an
  // evictor, the LRU cap, or a sweep racing this caller), the shim transparently
  // re-acquires the org's LIVE pool instead of throwing "Cannot use a pool after
  // calling end on the pool" at whoever happened to be mid-flight. The guards
  // above make that race rare; this makes it harmless, which is the difference
  // between a narrower window and a closed one. Re-acquire goes through
  // getTenantDb, so the reopened pool is the CACHED one — no orphaned pools.
  const shim = {
    connect: async () => {
      const dead = pool as unknown as { ended?: boolean; ending?: boolean };
      if (!dead.ended && !dead.ending) return pool.connect();
      await getTenantDb(orgId);
      const live = await cache.get(orgId);
      return (live?.pool ?? pool).connect();
    },
    end: () => pool.end(),
  };
  const db = new Kysely<TenantDB>({
    // Kysely's postgres driver only calls connect() and end(); the shim covers
    // both. Cast because it is not a full pg.Pool.
    dialect: new PostgresDialect({ pool: shim as unknown as Pool }),
  });
  return { pool, db };
}

export async function getTenantDb(orgId: string): Promise<Kysely<TenantDB>> {
  // Stamp BEFORE the await: the grace window must cover from the moment we
  // commit to handing out this pool, not from when the promise resolves.
  lastAccess.set(orgId, Date.now());
  accessSeq.set(orgId, ++seqCounter);
  let entry = cache.get(orgId);
  if (!entry) {
    handouts.set(orgId, 0); // new pool generation — this caller will be #1
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
  handouts.set(orgId, (handouts.get(orgId) ?? 0) + 1);
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
export async function releaseIdleTenantPool(orgId: string, ifSeqIs?: number): Promise<void> {
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
  // out a connection yet (so the counts above look idle). The one caller who
  // may skip this wait is the access's OWN owner: when `ifSeqIs` matches the
  // current access seq, nobody else has been handed the pool since that access,
  // and the owner calling release means it is done — safe to close now. That is
  // what lets a cross-tenant sweep run at ~one open pool instead of one per org.
  const untouchedByOthers = mayFastClose({
    handoutsSinceOpen: handouts.get(orgId) ?? 0,
    currentSeq: accessSeq.get(orgId),
    mySeq: ifSeqIs,
  });
  if (!untouchedByOthers && Date.now() - (lastAccess.get(orgId) ?? 0) < RELEASE_GRACE_MS) {
    // In the window → NOT a no-op (that silent no-op is how sweeps exhausted
    // Postgres): retry once the window has passed. Quiet pools then close;
    // a pool real traffic keeps touching re-defers, which is correct.
    if (!pendingRelease.has(orgId)) {
      const t = setTimeout(() => {
        pendingRelease.delete(orgId);
        void releaseIdleTenantPool(orgId);
      }, RELEASE_GRACE_MS + 250);
      t.unref?.();
      pendingRelease.set(orgId, t);
    }
    return;
  }
  cache.delete(orgId);
  lastAccess.delete(orgId);
  accessSeq.delete(orgId);
  handouts.delete(orgId);
  const pending = pendingRelease.get(orgId);
  if (pending) {
    clearTimeout(pending);
    pendingRelease.delete(orgId);
  }
  try {
    await pool.end();
  } catch {
    // Already ending, or a client raced the end — harmless; the cache entry
    // is gone, so the next access opens a fresh pool.
  }
}

/** Scoped tenant-DB access for cross-tenant background sweeps: hands `fn` the
 *  db, then releases the pool — immediately when nothing else touched it since
 *  this access (the common sweep case), otherwise via the grace-deferred path.
 *  This is what keeps a sweep across N tenants at ~one open pool. */
export async function withTenantDbForSweep<T>(
  orgId: string,
  fn: (db: Kysely<TenantDB>) => Promise<T>,
): Promise<T> {
  const db = await getTenantDb(orgId);
  const mySeq = accessSeq.get(orgId);
  try {
    return await fn(db);
  } finally {
    await releaseIdleTenantPool(orgId, mySeq);
  }
}

/** For tenant deletion — also useful in tests to reset the pool when
 *  the underlying DB has been dropped/recreated. */
export async function evictTenantPool(orgId: string): Promise<void> {
  const entry = cache.get(orgId);
  if (!entry) return;
  cache.delete(orgId);
  lastAccess.delete(orgId);
  accessSeq.delete(orgId);
  handouts.delete(orgId);
  const pending = pendingRelease.get(orgId);
  if (pending) {
    clearTimeout(pending);
    pendingRelease.delete(orgId);
  }
  try {
    const { pool } = await entry;
    await pool.end();
  } catch {
    // open() failed — nothing to close.
  }
}
