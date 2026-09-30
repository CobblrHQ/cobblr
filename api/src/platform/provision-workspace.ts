// A workspace is made whole or not at all.
//
// A workspace is a row in orgs and a database of its own. The row is written
// first; the database, its credentials and the default modules follow. When the
// second half failed (a staging Postgres ran out of shared memory mid-signup),
// the row stayed with no database, signup answered 201 anyway, and the person
// landed in a workspace that answered 503 tenant_unprovisioned on every page,
// forever: nothing ever tried again.
//
// So: finishProvisioning() does the second half and is safe to run again over
// a half-made one (it starts from a clean slate). provisionOrgForUser (every
// door that makes a workspace) tries it twice and, if it still fails, removes
// the row and throws WorkspaceNotProvisioned, which every route answers as a
// plain "try again" with nothing kept. The heal below finishes the workspaces
// the old code already left half made.
//
// meta and the heavier imports are lazy so the pure rule can be unit tested.

export class WorkspaceNotProvisioned extends Error {
  readonly code = "workspace_not_created";
  constructor(readonly orgName: string, cause: unknown) {
    super(`the workspace "${orgName}" could not be set up: ${(cause as Error)?.message ?? cause}`);
  }
}

/** The person-facing words for WorkspaceNotProvisioned, wherever it surfaces. */
export const WORKSPACE_NOT_CREATED_MESSAGE =
  "We could not set up the workspace just now, and nothing was kept. Please try again in a minute.";

/** Give a workspace row its database, credentials and default modules. Does
 *  nothing when it already has them. `resetFirst` clears a database an
 *  earlier attempt left half made. Throws when the database could not be
 *  made; module enabling is best effort, as at signup. */
export async function finishProvisioning(orgId: string, ownerId: string | null, opts: { resetFirst?: boolean } = {}): Promise<void> {
  const { meta } = await import("../db/meta.js");
  const org = await meta
    .selectFrom("orgs")
    .select(["db_name", "db_credentials_encrypted"])
    .where("id", "=", orgId)
    .executeTakeFirstOrThrow();
  if (org.db_credentials_encrypted) return;
  const { provisionTenantDb } = await import("../db/provision.js");
  const { credentialsEncrypted, migrationsApplied } = await provisionTenantDb(org.db_name, opts);
  await meta
    .updateTable("orgs")
    .set({ db_credentials_encrypted: credentialsEncrypted, updated_at: new Date() })
    .where("id", "=", orgId)
    .execute();
  console.log(`[org-provision] ${org.db_name} for org ${orgId} (${migrationsApplied} migrations)`);
  const activity = await import("./activity.js");
  try {
    await activity.log({
      orgId,
      userId: ownerId,
      action: "tenant_provisioned",
      ref: { module: null, entityType: "org", entityId: orgId },
      diff: { db_name: org.db_name },
    });
  } catch (err) {
    console.error("[org-provision] activity logging failed:", err);
  }
  try {
    // The always-on substrate plus the ambient capability modules; domain
    // modules stay off until the person opts in.
    const { enableDefaultModulesForOrg } = await import("../modules/enable.js");
    const enabled = await enableDefaultModulesForOrg(orgId, ownerId ?? undefined);
    if (enabled.length > 0) console.log(`[org-provision] enabled default modules for ${orgId}: ${enabled.join(", ")}`);
  } catch (err) {
    console.error("[org-provision] default-module enable failed:", err);
  }
}

/** The second half of making a workspace, made whole or not at all: one more
 *  try from a clean slate, then the row goes and WorkspaceNotProvisioned is
 *  thrown. Every door that makes a workspace comes through here
 *  (provisionOrgForUser). */
export async function provisionWholeOrRemove(
  orgId: string,
  orgName: string,
  ownerId: string | null,
  opts: { retryAfterMs?: number } = {},
): Promise<void> {
  try {
    await finishProvisioning(orgId, ownerId);
  } catch (first) {
    console.error(`[org-provision] ${orgId} failed, trying once more:`, (first as Error).message);
    try {
      await new Promise((r) => setTimeout(r, opts.retryAfterMs ?? 1_500));
      await finishProvisioning(orgId, ownerId, { resetFirst: true });
    } catch (err) {
      console.error(`[org-provision] ${orgId} failed twice; removing the half-made workspace:`, err);
      const { hardDeleteOrg } = await import("./delete-org.js");
      await hardDeleteOrg(orgId).catch((e) => console.error(`[org-provision] could not remove ${orgId}:`, (e as Error).message));
      throw new WorkspaceNotProvisioned(orgName, err);
    }
  }
}

export interface HalfMade {
  id: string;
  created_at: Date | string;
  owners: number;
}

/** Which half-made workspaces to finish now. One made in the last ten minutes
 *  may be a signup still in flight, and is left to it. Pure. */
export function halfMadeToFinish(rows: HalfMade[], nowMs: number): HalfMade[] {
  return rows.filter((r) => nowMs - new Date(r.created_at).getTime() > 10 * 60_000);
}
