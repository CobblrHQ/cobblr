// cobblr_meta connection + Kysely instance. One pool process-wide.
// Tenant connections live in db/tenant.ts (added in milestone 3).

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { env } from "../env.js";
import type { MetaDB } from "./schema.js";

export const metaPool = new Pool({
  connectionString: env.DATABASE_URL,
  // Modest size — cobblr_meta serves auth + tenant lookups, not
  // hot per-tenant queries.
  max: 10,
});

// Without an 'error' listener, a pg-pool idle-client error (e.g. the
// server killed an idle connection during shutdown, or a network
// blip) becomes an unhandled 'error' event and Node terminates the
// process. Per pg-pool docs, register one.
metaPool.on("error", (err) => {
  console.error("[meta-pool] idle client error:", (err as Error).message);
});

export const meta = new Kysely<MetaDB>({
  dialect: new PostgresDialect({ pool: metaPool }),
});

// Verify connectivity at startup — fail fast rather than blow up on
// the first authenticated request.
export async function pingMeta(): Promise<void> {
  await metaPool.query("select 1");
}
