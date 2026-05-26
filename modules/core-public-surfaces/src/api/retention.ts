// Daily retention sweep for core_public_surfaces_views, driven by
// core-queue. Validates the queue infrastructure with a real
// scheduled-cron workload.
//
// Pattern: self-rescheduling cron via queue.
//   1. onBoot registers a worker on the 'core-public-surfaces.daily-retention'
//      queue and enqueues a job per workspace if none is pending.
//   2. When the worker runs a job, it DELETEs view-log rows older than
//      90 days, then re-enqueues itself for ~24h later.
//
// This replaces the lazy "DELETE on every stats read" sweep with a
// proper scheduled prune that doesn't depend on someone opening the
// stats modal. The lazy sweep is harmless (it still works) but the
// scheduled one is what production-grade installs want.
//
// Per-workspace job isolation: each org gets its own daily job so a
// large tenant doesn't starve a small one. Worker only touches the
// org_id from the job payload.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";

const QUEUE_NAME = "core-public-surfaces.daily-retention";
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

/** Structural duck-type of the meta Kysely instance — we only need
 *  these two queries. Avoids dragging api's schema.ts into a module. */
interface MetaDbLike {
  selectFrom(table: "orgs"): {
    select(col: "id"): {
      execute(): Promise<Array<{ id: string }>>;
    };
  };
  selectFrom(table: "core_queue_jobs"): {
    select(col: "org_id"): {
      where(
        col: "queue",
        op: "=",
        v: string,
      ): {
        where(
          col: "status",
          op: "in",
          v: string[],
        ): {
          execute(): Promise<Array<{ org_id: string }>>;
        };
      };
    };
  };
}

/** Call from module onBoot. Registers the worker handler and seeds
 *  a first job for every workspace that doesn't already have one
 *  pending. Idempotent — calling twice on the same boot is a no-op
 *  (registerWorker logs a warning + replaces; seedJobs upserts). */
export async function startRetentionWorker(): Promise<void> {
  platform().queue.registerWorker(QUEUE_NAME, async (job) => {
    const tenantDb = (await platform().tenants.getDb(job.orgId)) as Kysely<TenantDB>;
    const result = await tenantDb
      .deleteFrom("core_public_surfaces_views")
      .where(
        sql<boolean>`viewed_at < now() - interval '${sql.raw(String(RETENTION_DAYS))} days'`,
      )
      .execute();
    const pruned = Number(result?.[0]?.numDeletedRows ?? 0);
    if (pruned > 0) {
      console.log(
        `[core-public-surfaces.retention] org ${job.orgId}: pruned ${pruned} rows`,
      );
    }
    // Re-enqueue tomorrow's job. The +24h drift is fine; we don't
    // need wall-clock precision for a retention sweep.
    await platform().queue.enqueue({
      orgId: job.orgId,
      queue: QUEUE_NAME,
      runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    });
  });
  await seedJobsForOrgs();
}

async function seedJobsForOrgs(): Promise<void> {
  const meta = platform().db.meta as MetaDbLike;
  const orgs = await meta.selectFrom("orgs").select("id").execute();
  const orgIds = orgs.map((o) => o.id);
  // Ask the kernel's queue primitive which orgs already have a
  // pending sweep — no need to peek inside core-queue's tables.
  const haveJob = await platform().queue.hasPendingJob({
    orgIds,
    queue: QUEUE_NAME,
  });
  for (const o of orgs) {
    if (haveJob.has(o.id)) continue;
    await platform().queue.enqueue({
      orgId: o.id,
      queue: QUEUE_NAME,
      // First run goes ~1h out to spread the seed-load over the
      // boot window. The 24h cadence kicks in after that.
      runAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  }
}
