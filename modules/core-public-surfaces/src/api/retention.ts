// Daily retention sweep for core_public_surfaces_views: view-log rows older
// than 90 days are pruned, once a day, in every workspace that has the
// module.
//
// It used to be a self-rescheduling core-queue job per workspace (one row a
// day per org, seeded for EVERY org at boot, the worker reading the tenant
// through getDb with nothing releasing the pool). The kernel's tenant walk
// is the right home for a pass that visits every workspace on a cadence
// (platform().sweeps, #3036): one registration, the module's own scope so a
// workspace without the table is never asked, the pool opened once per visit
// and released on the way out, the first round spread over the day.
//
// The lazy "DELETE on every stats read" in surfaces.ts still works; this is
// what makes the prune happen without anyone opening the stats modal.
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";

export const RETENTION_PASS = "core-public-surfaces.retention";
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;

interface ViewsTable {
  id: string;
  surface_id: string;
  viewed_at: Date;
}

interface TenantDB {
  core_public_surfaces_views: ViewsTable;
}

/** Call from module onBoot: registers the daily pass. Idempotent. */
export async function startRetentionWorker(): Promise<void> {
  platform().sweeps.register({
    name: RETENTION_PASS,
    everyMs: SWEEP_INTERVAL_MS,
    module: "core-public-surfaces",
    visit: async ({ orgId, db }) => {
      const tenantDb = db as Kysely<TenantDB>;
      const result = await tenantDb
        .deleteFrom("core_public_surfaces_views")
        .where(sql<boolean>`viewed_at < now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`)
        .execute();
      const pruned = Number(result?.[0]?.numDeletedRows ?? 0);
      if (pruned > 0) {
        console.log(`[core-public-surfaces.retention] org ${orgId}: pruned ${pruned} rows`);
      }
      return { pruned };
    },
  });
}
