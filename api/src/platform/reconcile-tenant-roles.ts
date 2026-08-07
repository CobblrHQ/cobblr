// Sweep orphaned per-tenant Postgres ROLES — the ones a deleted workspace left
// behind.
//
// PERMANENT RECONCILE. Provisioning creates a `tenant_<id>_user` role alongside
// each tenant database (db/provision.ts). Roles are CLUSTER-GLOBAL, so
// `DROP DATABASE` does not remove them: for a long time `hardDeleteOrg` dropped
// the database and left the role forever. Measured 2026-08-07: staging carried
// 265 roles against 251 databases — 14 orphans.
//
// hardDeleteOrg now drops the role itself, so no NEW orphans appear. This stays
// permanent for two reasons:
//   1. Instances that deleted workspaces before that fix still carry orphans,
//      and there is no other thing that would ever remove them.
//   2. It is the class-fix, not a per-callsite fix: ANY future delete path that
//      forgets the role (or a delete that dies between the two statements) is
//      healed on the next boot instead of leaking silently.
//
// Cost on a healthy instance: ONE query that returns no rows. It opens no tenant
// pools and writes nothing.
//
// SAFETY: a role is dropped only when its database is gone AND no org row claims
// it. An org whose database vanished is a BROKEN workspace, not an orphan — its
// role is left alone and the situation is logged loudly, because dropping the
// role would destroy the last thing needed to reattach a restored database.

import { Client } from "pg";
import { env } from "../env.js";
import { meta } from "../db/meta.js";

/** Same shape provision.ts creates: `tenant_<short-uuid>_user`. */
const TENANT_ROLE = /^tenant_[a-z0-9_]+_user$/;

export interface OrphanRoleSweep {
  dropped: number;
  skippedBroken: number;
}

export async function reconcileOrphanTenantRoles(): Promise<OrphanRoleSweep> {
  const out: OrphanRoleSweep = { dropped: 0, skippedBroken: 0 };
  // Dropping a role needs CREATEROLE/superuser, which the app's own user does
  // not have — that is WHY the original delete could not do it. No superuser
  // URL (a deploy that never provisions tenants) means nothing to do here.
  if (!env.SUPERUSER_DATABASE_URL) return out;

  const client = new Client({ connectionString: env.SUPERUSER_DATABASE_URL });
  try {
    await client.connect();
    // One round trip: every tenant-shaped role with no database of the same
    // name. Postgres owns both catalogs, so this is authoritative and cheap.
    const { rows } = await client.query<{ rolname: string }>(
      `SELECT r.rolname
         FROM pg_roles r
        WHERE r.rolname ~ '^tenant_.+_user$'
          AND NOT EXISTS (
                SELECT 1 FROM pg_database d
                 WHERE d.datname = left(r.rolname, length(r.rolname) - 5))`,
    );
    if (rows.length === 0) return out;

    // Cross-check against the registry before touching anything.
    const claimed = new Set(
      (await meta.selectFrom("orgs").select("db_name").execute())
        .map((o) => o.db_name)
        .filter((n): n is string => !!n),
    );

    for (const { rolname } of rows) {
      const dbName = rolname.slice(0, -"_user".length);
      if (claimed.has(dbName)) {
        out.skippedBroken++;
        console.error(
          `[reconcile-tenant-roles] org still claims ${dbName} but that database is GONE — ` +
            `leaving role ${rolname} in place (a restore needs it). Investigate this workspace.`,
        );
        continue;
      }
      // Defence in depth: the name came from pg_roles, not a request, but never
      // splice an unvalidated identifier into DDL.
      if (!TENANT_ROLE.test(rolname)) continue;
      try {
        await client.query(`DROP ROLE IF EXISTS "${rolname}"`);
        out.dropped++;
      } catch (err) {
        // A role still owning objects elsewhere, or a permissions gap. One
        // failure must not abort the sweep.
        console.error(
          `[reconcile-tenant-roles] could not drop ${rolname}: ${(err as Error).message}`,
        );
      }
    }
    if (out.dropped > 0) {
      console.log(
        `[reconcile-tenant-roles] dropped ${out.dropped} orphaned tenant role(s) left by deleted workspaces`,
      );
    }
    return out;
  } catch (err) {
    // Never let a cleanup sweep take down boot.
    console.error(`[reconcile-tenant-roles] sweep failed: ${(err as Error).message}`);
    return out;
  } finally {
    await client.end().catch(() => {});
  }
}
