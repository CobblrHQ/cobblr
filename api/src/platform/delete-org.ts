// Hard-delete a workspace: drop the tenant DB, clear the non-cascading
// meta rows, remove the org row. Shared by the owner-facing
// DELETE /orgs/:slug and the operator console's
// DELETE /super-admin/workspaces/:id (cleaning up e2e/test detritus is an
// operator chore — console audit 2026-06-11). AUTHZ IS THE CALLER'S JOB.

import { meta } from "../db/meta.js";
import { metaPool } from "../db/meta.js";
import { evictTenantPool } from "../db/tenant.js";
import { getSandboxedModuleInfo } from "../sandbox/sandboxed-module-info.js";
import { dropModuleRole } from "../sandbox/module-role.js";

export async function hardDeleteOrg(orgId: string): Promise<void> {
  const dbName = await meta
    .selectFrom("orgs")
    .select("db_name")
    .where("id", "=", orgId)
    .executeTakeFirstOrThrow();

  // Collect this org's sandboxed modules BEFORE we delete their
  // org_modules rows — their global Postgres roles must be dropped after
  // the tenant DB is gone (roles are cluster-global, so DROP DATABASE
  // alone leaves them orphaned). (Audit follow-up #1.)
  const moduleRows = await meta
    .selectFrom("org_modules")
    .select("module_name")
    .where("org_id", "=", orgId)
    .execute();
  const sandboxedModules = moduleRows
    .map((r) => r.module_name)
    .filter((m) => getSandboxedModuleInfo(m) !== null);

  // Close any cached connection pool to the tenant DB BEFORE dropping
  // it. Otherwise DROP DATABASE WITH (FORCE) kills active connections
  // and the resulting pg error can take the api process down with it.
  await evictTenantPool(orgId);

  // Terminate any other connections to the DB (background tasks,
  // hung queries) then DROP. CREATE/DROP DATABASE can't run inside
  // a tx — also can't run while you're connected to the target DB,
  // so we issue from the meta pool.
  try {
    await metaPool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName.db_name],
    );
    await metaPool.query(`DROP DATABASE IF EXISTS "${dbName.db_name}"`);
  } catch (err) {
    console.error(`[delete-org] failed to drop tenant DB ${dbName.db_name}:`, err);
    // Fall through — DB drop failing doesn't block the meta cleanup,
    // since the credentials are encrypted on the org row and the
    // user can't reach a stranded DB anyway.
  }

  // Drop the now-orphaned per-module roles (best-effort; DROP DATABASE
  // above removed their grant dependencies so DROP ROLE is clean).
  for (const moduleName of sandboxedModules) {
    await dropModuleRole(orgId, moduleName);
  }

  // FKs with ON DELETE CASCADE handle most child rows
  // (memberships, modules, bundles, bindings, field_defs, invites).
  // activity_log doesn't cascade — clear it explicitly.
  await meta.deleteFrom("activity_log").where("org_id", "=", orgId).execute();
  await meta.deleteFrom("notifications").where("org_id", "=", orgId).execute();
  await meta.deleteFrom("notification_subscriptions").where("org_id", "=", orgId).execute();
  await meta.deleteFrom("orgs").where("id", "=", orgId).execute();
}
