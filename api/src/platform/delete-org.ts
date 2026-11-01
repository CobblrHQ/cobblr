// Hard-delete a workspace: drop the tenant DB, clear the non-cascading
// meta rows, remove the org row. Shared by the owner-facing
// DELETE /orgs/:slug and the operator console's
// DELETE /super-admin/workspaces/:id (cleaning up e2e/test detritus is an
// operator chore — console audit 2026-06-11). AUTHZ IS THE CALLER'S JOB.

import { platform } from "@cobblr/platform-contract";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { createClient } from "../db/client-error-guard.js";
import { metaPool } from "../db/meta.js";
import { env } from "../env.js";
import { evictTenantPool, withTenantDeleting } from "../db/tenant.js";
import { currentRequestScope } from "../lib/request-context.js";
import { getSandboxedModuleInfo } from "../sandbox/sandboxed-module-info.js";
import {removeServerBridgeEnrollment} from "./server-bridge-files.js";
import { dropModuleRole } from "../sandbox/module-role.js";

// How long a delete waits for clients a request still holds on the tenant
// pool before terminating their backends anyway. Long enough for any request
// that is answering normally; short enough that one stuck query cannot hold a
// deletion open. The held request errors through its own query path.
const DRAIN_MS = Number(process.env.COBBLR_DELETE_DRAIN_MS) || 5_000;

/** The steps of a workspace's delete, in the order that leaves nothing a
 *  person can meet half done. The database and the server's rows are two
 *  commits, so the intent is committed first: a delete that dies after the
 *  drop leaves a row stamped `dropping_at`, which the tenant door answers as
 *  being deleted, the switcher leaves out, and the deletion reaper finishes.
 *  Unstamped, it left a workspace with no database in every member's
 *  switcher, which the reaper could never finish (#9071). */
export interface DeleteSteps {
  /** Commits `orgs.dropping_at`; every later step may die and be run again. */
  mark: (orgId: string) => Promise<void>;
  eraseFiles: (orgId: string) => Promise<void>;
  /** Drops the database and its roles; a database already gone is fine. */
  dropDatabase: (orgId: string) => Promise<void>;
  /** Every row of the workspace on the server, in one transaction. */
  removeRows: (orgId: string) => Promise<void>;
  afterRows: (orgId: string) => Promise<void>;
  /** Holds the workspace closed to new requests while `work` runs. */
  closed: (orgId: string, work: () => Promise<void>) => Promise<void>;
}

export async function deleteOrgWith(orgId: string, steps: DeleteSteps): Promise<void> {
  await steps.mark(orgId);
  // The workspace's stored files first, while its database (which lists them)
  // still opens: inside withTenantDeleting nothing can open it. Dropping the
  // database used to be the whole delete, so every photo and file of every
  // deleted workspace stayed on disk for good. A failure is loud but does not
  // keep the workspace: the person asked for it gone.
  try {
    await steps.eraseFiles(orgId);
  } catch (err) {
    console.error(`[delete-org] org ${orgId}: its stored files were not all removed:`, (err as Error).message);
  }
  // Marked as deleting for the whole run: a request that lands in here gets a
  // refusal from getTenantDb instead of opening a fresh pool to a database
  // whose backends are about to be terminated (#2957).
  await steps.closed(orgId, async () => {
    await steps.dropDatabase(orgId);
    await steps.removeRows(orgId);
  });
  await steps.afterRows(orgId);
}

const realSteps: DeleteSteps = {
  mark: async (orgId) => {
    await meta.updateTable("orgs").set({ dropping_at: sql`coalesce(dropping_at, now())` as never }).where("id", "=", orgId).execute();
  },
  eraseFiles: (orgId) => platform().files.eraseWorkspace(orgId),
  dropDatabase: (orgId) => dropDatabase(orgId),
  removeRows: (orgId) => removeRows(orgId),
  afterRows: (orgId) => removeServerBridgeEnrollment(orgId),
  closed: (orgId, work) => withTenantDeleting(orgId, work),
};

export async function hardDeleteOrg(orgId: string): Promise<void> {
  // Who asked, by route and (in a test run) the test file, so a read that
  // meets a workspace mid-deletion can be traced to the request that removed
  // it (#7682: a search met one and nothing said whose teardown it was).
  console.log(`[delete-org] deleting workspace ${orgId}, asked by ${currentRequestScope()?.label ?? "no request (a sweep or a boot pass)"}`);
  await deleteOrgWith(orgId, realSteps);
}

async function dropDatabase(orgId: string): Promise<void> {
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

  // Close the cached connection pool to the tenant DB BEFORE dropping it, so
  // the api's own connections are gone rather than terminated under it. A
  // client a request still holds is given DRAIN_MS; past that the terminate
  // below ends its query, which is the right outcome for a request on a
  // workspace being deleted, and every client listens for the resulting
  // 'error' from creation (db/client-error-guard.ts), so it is a log line.
  const drain = await evictTenantPool(orgId, { drainMs: DRAIN_MS });
  if (!drain.drained) {
    console.warn(
      `[delete-org] org ${orgId}: ${drain.borrowed} client(s) still borrowed after ${DRAIN_MS}ms; terminating their backends`,
    );
  }

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

  // Drop the TENANT'S OWN role too. Roles are cluster-global, so the DROP
  // DATABASE above did not remove it — for a long time this function dropped
  // the database and left `tenant_<id>_user` behind forever (14 orphans on
  // staging by 2026-08-07). It needs the SUPERUSER connection: the app's own
  // user cannot DROP ROLE, which is why the original code could not do it here.
  // Best-effort — the workspace is already gone either way, and
  // reconcileOrphanTenantRoles() sweeps anything missed on the next boot.
  if (env.SUPERUSER_DATABASE_URL && /^tenant_[a-z0-9_]+$/.test(dbName.db_name)) {
    const roleName = `${dbName.db_name}_user`;
    const su = createClient({ connectionString: env.SUPERUSER_DATABASE_URL }, "delete-org superuser");
    try {
      await su.connect();
      await su.query(`DROP ROLE IF EXISTS "${roleName}"`);
    } catch (err) {
      console.error(`[delete-org] failed to drop tenant role ${roleName}:`, (err as Error).message);
    } finally {
      await su.end().catch(() => {});
    }
  }

}

async function removeRows(orgId: string): Promise<void> {
  await meta.transaction().execute(async (trx) => {
    // FKs with ON DELETE CASCADE handle most child rows
    // (memberships, modules, bundles, bindings, field_defs, invites).
    // activity_log doesn't cascade — clear it explicitly.
    await trx.deleteFrom("activity_log").where("org_id", "=", orgId).execute();
    await trx.deleteFrom("notifications").where("org_id", "=", orgId).execute();
    await trx.deleteFrom("notification_subscriptions").where("org_id", "=", orgId).execute();
    // Feedback is the operator's, not the workspace's: the report stays, under
    // the name it was filed from. (The foreign key clears org_id on its own too;
    // this is what keeps the name.)
    await trx
      .updateTable("feedback")
      .set((eb) => ({
        workspace_name: eb.selectFrom("orgs").select("name").where("id", "=", orgId),
        org_id: null,
        updated_at: sql`updated_at`,
      }))
      .where("org_id", "=", orgId)
      .execute();
    await trx.deleteFrom("orgs").where("id", "=", orgId).execute();
  });
}
