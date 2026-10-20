// One-shot heal: finish the workspaces the old signup left half made.
// KEEP UNTIL: a stable release has shipped with this file in it (it was restored for 2026.10.0, #7679); lint:heal-shims holds the deletion to that.
//
// DONE WHEN: `heal_shims` for this file reads found 0 on every deployment
// that runs it (GET /api/v1/healthz; deploy-gap also reports "workspace never
// provisioned"). Then delete this file and its
// boot call.
// BORN WITH: provisionOrgForUser (every door that makes a workspace now makes
// it whole or removes it and says so, so no new one is left half made).
//
// WHY IT EXISTS. Until provision-workspace.ts, a workspace whose database could
// not be made kept its row with no database, and answered 503
// tenant_unprovisioned on every page for good: five of them on staging after
// its Postgres ran out of shared memory mid-signup. Each is finished here the
// way signup would have: its database, credentials and default modules. One
// with no member left is removed instead, since nobody could ever open it.
// A workspace made in the last ten minutes is left alone (a signup may still
// be finishing it). One that still fails is counted and tried at the next boot.

import { finishProvisioning, halfMadeToFinish, type HalfMade } from "./provision-workspace.js";
import { notePassFailure } from "./pass-failures.js";

export async function healHalfMadeWorkspaces(
  now: Date = new Date(),
  opts: { only?: string[] } = {},
): Promise<{ finished: number; removed: number; failed: number }> {
  const { meta } = await import("../db/meta.js");
  const { sql } = await import("kysely");
  const rows = (
    await sql<HalfMade & { first_owner: string | null }>`
      select o.id, o.created_at,
        (select count(*)::int from org_memberships m where m.org_id = o.id and m.role = 'owner') as owners,
        (select m.user_id from org_memberships m where m.org_id = o.id and m.role = 'owner' order by m.joined_at limit 1) as first_owner
      from orgs o
      where o.db_credentials_encrypted is null
    `.execute(meta)
  ).rows;
  const due = halfMadeToFinish(opts.only ? rows.filter((r) => opts.only!.includes(r.id)) : rows, now.getTime());
  let finished = 0;
  let removed = 0;
  let failed = 0;
  for (const row of due as Array<HalfMade & { first_owner: string | null }>) {
    try {
      if (row.owners === 0) {
        const { hardDeleteOrg } = await import("./delete-org.js");
        await hardDeleteOrg(row.id);
        removed++;
        console.log(`[heal] half-made workspace ${row.id}: no owner, removed`);
      } else {
        await finishProvisioning(row.id, row.first_owner, { resetFirst: true });
        finished++;
        console.log(`[heal] half-made workspace ${row.id}: finished`);
      }
    } catch (err) {
      failed++;
      notePassFailure("healHalfMadeWorkspaces", row.id, err);
      console.error(`[heal] half-made workspace ${row.id}: still not provisioned (${(err as Error).message})`);
    }
  }
  if (!opts.only) {
    const { noteHealShim } = await import("./heal-shim-log.js");
    await noteHealShim("api/src/platform/heal-half-made-workspaces.ts", due.length, failed);
  }
  return { finished, removed, failed };
}
