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

const cache = new Map<string, CachedTenant>();

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

export async function getTenantDb(orgId: string): Promise<Kysely<TenantDB>> {
  const cached = cache.get(orgId);
  if (cached) return cached.db;

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
  const db = new Kysely<TenantDB>({ dialect: new PostgresDialect({ pool }) });
  cache.set(orgId, { pool, db });
  return db;
}

/** Pool accessor for callers that need raw pg (e.g. migration runner).
 *  Lazily opens the pool by going through getTenantDb. */
export async function getTenantPool(orgId: string): Promise<Pool> {
  await getTenantDb(orgId);
  return cache.get(orgId)!.pool;
}

/** For tenant deletion (added later) — also useful in tests to reset
 *  the pool when the underlying DB has been dropped/recreated. */
export async function evictTenantPool(orgId: string): Promise<void> {
  const cached = cache.get(orgId);
  if (!cached) return;
  cache.delete(orgId);
  await cached.pool.end();
}
