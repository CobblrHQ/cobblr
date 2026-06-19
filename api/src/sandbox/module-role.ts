// Per-(workspace, module) Postgres role — DB-level enforcement of the
// sandbox table-isolation policy (the durable layer behind the
// `runTenantQuery` SQL lexer). Audit 2026-06-19 finding #1 follow-up.
//
// WHY: the lexer in pool.ts/sql-guards.ts is a string firewall; it's
// been hardened, but the robust boundary is to let Postgres enforce
// access. Each sandboxed module gets its own NOLOGIN role granted ONLY
// on its `<prefix>_*` tables (+ SELECT on its declared `reads` tables).
// `runTenantQuery` does `SET LOCAL ROLE` to it, so a query touching any
// other table fails with "permission denied" no matter what the lexer
// missed.
//
// SAFE BY CONSTRUCTION (graceful fallback): role setup runs as the
// superuser. If `SUPERUSER_DATABASE_URL` is unset, or any step fails,
// `ensureModuleRole` returns false and the module simply is NOT marked
// ready → `runTenantQuery` skips `SET LOCAL ROLE` and behaves exactly
// as before (lexer-only). It can never break an enable or a query.
//
// Cross-tenant isolation is already enforced by separate per-org DBs +
// credentials (db/tenant.ts); this is intra-tenant (module-vs-module).

import { createHash } from "node:crypto";
import type { Client as PgClient } from "pg";

// env / meta / pg are imported LAZILY inside the DB-touching functions so
// that importing this module for the pure helpers (moduleRoleName /
// isModuleRoleReady) doesn't drag in env validation (which can
// process.exit on missing vars) — keeps the helpers unit-testable.

/** (orgId, moduleName) pairs whose role is created + granted in THIS
 *  process, so `runTenantQuery` knows it's safe to `SET LOCAL ROLE`.
 *  In-memory + per-process: each api instance populates it at boot
 *  retrofit / on enable. A miss just means lexer-only (safe). */
const ready = new Set<string>();
const keyOf = (orgId: string, moduleName: string) => `${orgId}::${moduleName}`;

/** Deterministic, globally-unique, ≤63-byte, valid-identifier role name.
 *  Postgres roles are cluster-global, so we hash the (orgId, module)
 *  pair (orgId is globally unique) rather than risk a collision or the
 *  identifier-length limit with raw names. */
export function moduleRoleName(orgId: string, moduleName: string): string {
  const h = createHash("sha1").update(`${orgId}/${moduleName}`).digest("hex").slice(0, 24);
  return `cm_${h}`; // e.g. cm_3f2a1b...  (27 chars)
}

export function isModuleRoleReady(orgId: string, moduleName: string): boolean {
  return ready.has(keyOf(orgId, moduleName));
}

/** The DB-level role layer is built dark — off unless explicitly enabled
 *  per-environment. When off, NOTHING role-related runs (no DDL, no
 *  superuser connections): behaviour is identical to the hardened-lexer
 *  path. Doubles as a kill-switch. */
export function moduleRolesEnabled(): boolean {
  return process.env.SANDBOX_MODULE_ROLES === "1";
}

/** A superuser pg Client pointed at a specific database (roles are
 *  global, but table/sequence grants must run against the tenant DB). */
async function superuserClientTo(dbName: string | null): Promise<PgClient> {
  const { env } = await import("../env.js");
  const { Client } = await import("pg");
  const u = new URL(env.SUPERUSER_DATABASE_URL);
  if (dbName) u.pathname = `/${dbName}`;
  return new Client({ connectionString: u.toString() });
}

/** Create (if missing) the module's role and (re)grant it exactly its
 *  own `<prefix>` tables + sequences, plus SELECT on the declared
 *  `reads` tables. Idempotent — safe to call on every enable + boot
 *  retrofit + after each migration run. Returns true when the role is
 *  ready (so the caller can `SET LOCAL ROLE`); false on any failure
 *  (caller falls back to the lexer). NEVER throws. */
export async function ensureModuleRole(opts: {
  orgId: string;
  moduleName: string;
  /** Table-prefix the module owns, e.g. "url_archive_". */
  prefix: string;
  /** Fully-qualified cross-module tables the manifest grants SELECT on. */
  readsTables: string[];
}): Promise<boolean> {
  const { orgId, moduleName, prefix, readsTables } = opts;
  if (!moduleRolesEnabled()) return false;
  const { env } = await import("../env.js");
  if (!env.SUPERUSER_DATABASE_URL) return false;
  const { meta } = await import("../db/meta.js");
  const role = moduleRoleName(orgId, moduleName);
  let client: PgClient | null = null;
  try {
    const org = await meta
      .selectFrom("orgs")
      .select("db_name")
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org?.db_name) return false;
    const dbName = org.db_name;
    const tenantUser = `${dbName}_user`;

    client = await superuserClientTo(dbName);
    await client.connect();

    // 1. Role (NOLOGIN) + membership so the tenant user can SET ROLE to it.
    //    Exception-catching DO (not IF NOT EXISTS) so two api containers
    //    racing the same CREATE during a blue-green rollout don't error.
    await client.query(
      `DO $$ BEGIN
         CREATE ROLE "${role}" NOLOGIN;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END $$;`,
    );
    await client.query(`GRANT "${role}" TO "${tenantUser}"`);
    await client.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);

    // 2. Enumerate public tables/sequences and filter by prefix in JS —
    //    avoids LIKE-wildcard escaping (the prefix is full of `_`, which
    //    is a LIKE metacharacter).
    const allTables = (
      await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
      )
    ).rows.map((r) => r.tablename);
    const ownTables = allTables.filter((t) => t.startsWith(prefix));
    const seqs = (
      await client.query<{ sequencename: string }>(
        `SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'`,
      )
    ).rows.map((r) => r.sequencename).filter((s) => s.startsWith(prefix));

    const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;
    if (ownTables.length) {
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${ownTables.map(quote).join(", ")} TO "${role}"`,
      );
    }
    if (seqs.length) {
      await client.query(
        `GRANT USAGE, SELECT ON SEQUENCE ${seqs.map(quote).join(", ")} TO "${role}"`,
      );
    }
    // 3. Cross-module reads — SELECT only, and only on tables that exist.
    const present = new Set(allTables);
    const grantableReads = readsTables.filter((t) => present.has(t));
    if (grantableReads.length) {
      await client.query(`GRANT SELECT ON ${grantableReads.map(quote).join(", ")} TO "${role}"`);
    }

    ready.add(keyOf(orgId, moduleName));
    return true;
  } catch (err) {
    // Graceful: log once, leave the module unmarked → lexer-only.
    console.error(`[module-role] ensure failed for ${moduleName}@${orgId}:`, (err as Error).message);
    return false;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

/** Drop a module's role (org-delete / module teardown). Best-effort:
 *  call AFTER the tenant DB is dropped so the role has no remaining
 *  grant dependencies. NEVER throws. */
export async function dropModuleRole(orgId: string, moduleName: string): Promise<void> {
  if (!moduleRolesEnabled()) return;
  const { env } = await import("../env.js");
  if (!env.SUPERUSER_DATABASE_URL) return;
  const role = moduleRoleName(orgId, moduleName);
  let client: PgClient | null = null;
  try {
    client = await superuserClientTo(null); // default DB — the tenant DB may be gone
    await client.connect();
    await client.query(`DROP ROLE IF EXISTS "${role}"`);
  } catch (err) {
    console.error(`[module-role] drop failed for ${moduleName}@${orgId}:`, (err as Error).message);
  } finally {
    ready.delete(keyOf(orgId, moduleName));
    if (client) await client.end().catch(() => {});
  }
}
