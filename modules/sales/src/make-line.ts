// "Make this" on an order line: the one implementation behind the route and
// the sales:make-line action. Plans a builds work order for the line's part,
// made for this order, starts a Make for it in digifab when that is here, and
// says both on the order's history (the Make's id is how the line links to it).

import { type Kysely } from "kysely";
import type { SalesDB } from "./db.js";
import { orderHappened } from "./history.js";
import { makeForOrder, startMakeFor } from "./work-orders.js";

export type MakeLineResult =
  | { ok: true; plannedId: string; buildName: string; qty: number; reused: boolean; makeId: string | null }
  | { ok: false; code: string; message: string; module?: string; doors?: Array<{ kind: "add_build"; label: string; href: string }> };

export async function makeLine(
  db: Kysely<SalesDB>,
  orgId: string,
  userId: string | null,
  orderId: string,
  lineId: string,
  qty: number,
  instance?: string,
): Promise<MakeLineResult> {
  let q = db.selectFrom("sales_orders").select(["id", "status"]).where("id", "=", orderId);
  if (instance) q = q.where("instance", "=", instance);
  const order = await q.executeTakeFirst();
  if (!order) return { ok: false, code: "not_found", message: "That order is not here any more." };
  if (["shipped", "closed", "cancelled"].includes(order.status)) {
    return { ok: false, code: "order_done", message: `This order is ${order.status}; there is nothing left to make for it.` };
  }
  const line = await db.selectFrom("sales_order_items").select(["id", "part_id", "description"]).where("id", "=", lineId).where("order_id", "=", orderId).executeTakeFirst();
  if (!line) return { ok: false, code: "not_found", message: "That line is not on this order any more." };
  if (!line.part_id) return { ok: false, code: "not_a_part", message: `"${line.description ?? "This line"}" is not a tracked part, so there is nothing to make.` };
  const r = await makeForOrder(orgId, userId, orderId, line.part_id, qty);
  if (!r.ok) {
    return {
      ok: false,
      code: r.code,
      message: r.message,
      ...(r.code === "module_not_enabled" ? { module: r.module } : {}),
      ...(r.code === "no_build" ? { doors: [{ kind: "add_build" as const, label: "Add a build", href: "/builds" }] } : {}),
    };
  }
  // A work order put in again keeps the Make it already has; a new one starts its own.
  const makeId = (r.reused ? await makeIdsByWorkOrder(db, orderId).then((m) => m.get(r.plannedId)) : undefined) ?? (await startMakeFor(orgId, userId, orderId, `${qty} × ${r.buildName || line.description || "part"}`));
  await orderHappened(db, orgId, orderId, {
    kind: "work_order",
    detail: { planned_id: r.plannedId, build_name: r.buildName, qty, line_id: lineId, reused: r.reused, make_id: makeId },
    by_user: userId,
  });
  return { ok: true, plannedId: r.plannedId, buildName: r.buildName, qty, reused: r.reused, makeId };
}

/** Each work order's Make, as the order's history recorded it. */
export async function makeIdsByWorkOrder(db: Kysely<SalesDB>, orderId: string): Promise<Map<string, string>> {
  const rows = await db.selectFrom("sales_order_history").select(["detail"]).where("order_id", "=", orderId).where("kind", "=", "work_order").orderBy("created_at", "asc").execute();
  const out = new Map<string, string>();
  for (const row of rows) {
    const d = (row.detail ?? {}) as { planned_id?: unknown; make_id?: unknown };
    if (typeof d.planned_id === "string" && typeof d.make_id === "string") out.set(d.planned_id, d.make_id);
  }
  return out;
}
