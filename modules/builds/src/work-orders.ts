// Work orders: planned builds, and how much of each has been made.
//
// "Made" is never stored. It is the good count the build's one quality record
// holds (builds_op_qty: hand-logged good parts and judged prints alike), handed
// out to the build's planned orders oldest first. So two orders for the same
// part never both claim the same brackets, a plate that makes more than the
// first order needs spills into the next, and a re-delivered verdict (which the
// quality record already refuses to count twice) cannot count twice here
// either. An order is done when what it has been handed reaches its qty.

import { type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { BuildsDB } from "./db.js";

export interface WorkOrderMade {
  id: string;
  build_id: string;
  qty: number;
  made: number;
  status: string;
  source_kind: string | null;
  source_id: string | null;
  created_at: Date;
}

/**
 * Hand a build's good count out to its planned orders, oldest first.
 *
 * The pool is every good part counted for the build since its oldest
 * non-cancelled planned order was made. Orders already marked done take their
 * full qty first (they were filled), so what they used is never handed on.
 */
export async function madeByWorkOrder(db: Kysely<BuildsDB>, buildIds: string[]): Promise<Map<string, WorkOrderMade>> {
  const out = new Map<string, WorkOrderMade>();
  if (buildIds.length === 0) return out;
  const plans = await db
    .selectFrom("builds_planned")
    .select(["id", "build_id", "qty", "status", "source_kind", "source_id", "created_at"])
    .where("build_id", "in", buildIds)
    .where("status", "!=", "cancelled")
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
  const byBuild = new Map<string, typeof plans>();
  for (const p of plans) (byBuild.get(p.build_id) ?? byBuild.set(p.build_id, []).get(p.build_id)!).push(p);
  for (const [buildId, list] of byBuild) {
    const since = list[0]!.created_at;
    const goodRows = await db
      .selectFrom("builds_op_qty")
      .select(["quantity"])
      .where("build_id", "=", buildId)
      .where("kind", "=", "good")
      .where("logged_at", ">=", since)
      .execute();
    let pool = goodRows.reduce((a, r) => a + (Number(r.quantity) || 0), 0);
    for (const p of list) {
      const qty = Number(p.qty) || 0;
      const made = Math.min(qty, pool);
      pool -= made;
      out.set(p.id, {
        id: p.id,
        build_id: p.build_id,
        qty,
        made,
        status: p.status,
        source_kind: p.source_kind,
        source_id: p.source_id,
        created_at: p.created_at,
      });
    }
  }
  return out;
}

/** Mark every open work order of a build that has been handed its full qty
 *  done, and say so. Called after good parts are counted. */
export async function closeFilledWorkOrders(db: Kysely<BuildsDB>, orgId: string, buildId: string): Promise<string[]> {
  const made = await madeByWorkOrder(db, [buildId]);
  const closed: string[] = [];
  for (const w of made.values()) {
    if (w.status !== "planned" || w.qty <= 0 || w.made < w.qty) continue;
    const r = await db
      .updateTable("builds_planned")
      .set({ status: "done", updated_at: new Date() })
      .where("id", "=", w.id)
      .where("status", "=", "planned")
      .executeTakeFirst();
    if (Number(r.numUpdatedRows ?? 0n) === 0) continue;
    closed.push(w.id);
    await platform().events.emit("builds.planned.completed", {
      orgId,
      plannedId: w.id,
      buildId,
      sourceKind: w.source_kind,
      sourceId: w.source_id,
      made: w.made,
    });
  }
  return closed;
}
