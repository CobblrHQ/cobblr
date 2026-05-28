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
    max: 5,
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
  let entry = cache.get(orgId);
  if (!entry) {
    entry = openTenant(orgId);
    cache.set(orgId, entry);
    // A failed open must not poison the cache forever — let the next
    // call retry (only evict if our promise is still the cached one).
    entry.catch(() => {
      if (cache.get(orgId) === entry) cache.delete(orgId);
    });
  }
  return (await entry).db;
}

/** Pool accessor for callers that need raw pg (e.g. migration runner).
 *  Lazily opens the pool by going through getTenantDb. */
export async function getTenantPool(orgId: string): Promise<Pool> {
  await getTenantDb(orgId);
  return (await cache.get(orgId)!).pool;
}

/** For tenant deletion — also useful in tests to reset the pool when
 *  the underlying DB has been dropped/recreated. */
export async function evictTenantPool(orgId: string): Promise<void> {
  const entry = cache.get(orgId);
  if (!entry) return;
  cache.delete(orgId);
  try {
    const { pool } = await entry;
    await pool.end();
  } catch {
    // open() failed — nothing to close.
  }
}
