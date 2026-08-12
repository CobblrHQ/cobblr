// HISTORICAL DATA MIGRATION — not kernel logic.
// DONE WHEN: the boot pass reports rowsRepaired=0 on prod + staging + dev
// consistently (every workspace's affected rows have been restored, and the
// fixes in core-scan mean no new ones can be created); then delete this file
// and its boot call.
//
// Between the keyword fallback's rename path shipping and 2026-08-12, a Replay
// that found nothing in the AI cache degraded to the keyword heuristic, and that
// heuristic's candidate name was written back over the row's real name. The
// heuristic derives its name by cutting the stored one at the first sentence
// break, and it read a decimal point as one, so a scan named
//
//     "Voron 0.1 3D Printer (partially built)"
//
// came back as "Voron 0". Both faults are fixed in core-scan (a heuristic
// candidate can no longer rename anything, and a decimal is no longer a sentence
// break), but rows already damaged stay damaged, and the user did nothing to
// cause it. So we put them back.
//
// WHAT MAKES A ROW REPAIRABLE. The rerun handler snapshots the pre-run identity
// into suggested_metadata.pre_rerun before it starts, and that snapshot survives
// until an undo consumes it. A row qualifies only when ALL of:
//
//   1. pre_rerun.name exists and differs from the current name,
//   2. the CURRENT name is a strict PREFIX of it,
//   3. the cut lands exactly on a DECIMAL POINT ("Voron 0" | ".1 3D Printer…"),
//   4. the top stored candidate is flagged `heuristic` — the keyword fallback's
//      own signature, and the only writer that could have made this edit.
//
// All four together, deliberately, because this pass WRITES TO REAL WORKSPACE
// DATA and the row carries no "the user typed this name" marker to defer to.
// A legitimate Re-run AI that shortened a name ("Coca-Cola Classic 2 L" to
// "Coca-Cola") satisfies 1 and 2, and reverting THAT would be us overruling the
// model on the user's behalf. So would reverting a hand-edit a user made after a
// re-run. Conditions 3 and 4 are what separate those from the defect: cutting at
// a comma or a real sentence end was always intended behaviour of the name
// cleaner, and only the decimal was ever wrong.
//
// One row per damaged item, name only: the candidates, fields, category and
// photos are left alone, because a replay could not have made those worse in a
// way we can identify from here.
//
// Scoped to workspaces with core-scan enabled (a meta query) so a workspace that
// never scanned anything opens no tenant pool at all. Per-org try/catch, pool
// evicted in a finally. Idempotent: the UPDATE filters on the damaged shape, so
// a second run matches nothing. Skip with COBBLR_SKIP_HISTORICAL_MIGRATIONS=1.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb, evictTenantPool } from "../db/tenant.js";
import { TRUNCATED_BY_FALLBACK_SQL } from "./replay-truncation-predicate.js";

export async function repairReplayTruncatedNames(): Promise<{ orgsTouched: number; rowsRepaired: number }> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") return { orgsTouched: 0, rowsRepaired: 0 };

  const orgs = await meta
    .selectFrom("org_modules")
    .select("org_id")
    .where("module_name", "=", "core-scan")
    .execute();

  let orgsTouched = 0;
  let rowsRepaired = 0;

  for (const { org_id } of orgs) {
    try {
      const db = await getTenantDb(org_id);
      const res = await sql<{ id: string }>`
        with damaged as (
          select id,
                 suggested_name as cur_name,
                 suggested_metadata->'pre_rerun'->>'name' as prev
            from core_scan_inbox_items
           where suggested_name is not null
             and suggested_metadata->'pre_rerun'->>'name' is not null
             and suggested_metadata->'pre_rerun'->>'name' <> suggested_name
             -- …and the keyword fallback is what wrote it
             and (suggested_candidates->0->>'heuristic')::boolean is true
        )
        update core_scan_inbox_items t
           set suggested_name = d.prev,
               updated_at     = now()
          from damaged d
         where t.id = d.id
           and ${sql.raw(TRUNCATED_BY_FALLBACK_SQL)}
        returning t.id
      `.execute(db as never);
      if (res.rows.length) {
        orgsTouched++;
        rowsRepaired += res.rows.length;
        console.log(`[reconcile] org ${org_id}: restored ${res.rows.length} scan name(s) a replay had truncated`);
      }
    } catch (err) {
      // One workspace's failure never blocks the rest.
      console.warn(`[reconcile] org ${org_id}: replay-name repair failed:`, (err as Error)?.message ?? err);
    } finally {
      evictTenantPool(org_id);
    }
  }

  return { orgsTouched, rowsRepaired };
}
