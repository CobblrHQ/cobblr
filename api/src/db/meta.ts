// cobblr_meta connection + Kysely instance. One pool process-wide.
// Tenant connections live in db/tenant.ts (added in milestone 3).

import { Kysely, PostgresDialect } from "kysely";
import { env } from "../env.js";
import type { MetaDB } from "./schema.js";
import { createPool } from "./client-error-guard.js";

// createPool: every client is listening for 'error' from creation, so a
// backend that goes away is a log line, never a process exit (the guard file
// carries the history).
export const metaPool = createPool({
  connectionString: env.DATABASE_URL,
  // Modest size — cobblr_meta serves auth + tenant lookups, not
  // hot per-tenant queries. COBBLR_META_POOL_MAX exists for processes
  // that import `meta` but barely use it directly: each of CI's 8 vitest
  // forks opens its OWN pool, so the default 10 costs up to 80 backends
  // of the runner Postgres's headroom for a handful of helper queries —
  // the ci.yml test step caps them at 3. The api itself keeps the default.
  max: Number(process.env.COBBLR_META_POOL_MAX) || 10,
}, "meta-pool");

export const meta = new Kysely<MetaDB>({
  dialect: new PostgresDialect({ pool: metaPool }),
});

// Verify connectivity at startup — fail fast rather than blow up on
// the first authenticated request.
export async function pingMeta(): Promise<void> {
  await metaPool.query("select 1");
}
