// Adding, changing and removing an order's lines: one copy for the routes and
// the actions, each change on the order's timeline and in the workspace log
// (through orderHappened). A line that is not on the order is said to be not
// there, never answered as if it had been removed.

import { withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import type { Kysely } from "kysely";
import type { SalesDB } from "./db.js";
import { orderHappened } from "./history.js";

type Db = Kysely<SalesDB>;

export interface LineValues {
  part_id?: string | null;
  description?: string | null;
  qty?: number;
  unit_price?: number | null;
  metadata?: Record<string, unknown>;
}

const said = (l: { description: string | null; qty: unknown; unit_price: unknown; part_id: string | null }) => ({
  description: l.description,
  qty: Number(l.qty),
  unit_price: l.unit_price === null ? null : Number(l.unit_price),
  part_id: l.part_id,
});

export async function addLine(db: Db, orgId: string, userId: string | null, orderId: string, v: LineValues & { qty: number }) {
  const row = await db
    .insertInto("sales_order_items")
    .values({ ...v, order_id: orderId, metadata: v.metadata ?? {} } as never)
    .returningAll()
    .executeTakeFirstOrThrow();
  await orderHappened(db, orgId, orderId, { kind: "line", detail: { change: "added", line_id: row.id, ...said(row) }, by_user: userId });
  return row;
}

/** Null when the line is not on this order. The log keeps what each changed
 *  value was before. */
export async function changeLine(db: Db, orgId: string, userId: string | null, orderId: string, lineId: string, patch: LineValues) {
  const before = await db.selectFrom("sales_order_items").selectAll().where("id", "=", lineId).where("order_id", "=", orderId).executeTakeFirst();
  if (!before) return null;
  const row = await db
    .updateTable("sales_order_items")
    // Custom fields MERGE into the live row (withMetadataMerged, #3625).
    .set(withMetadataMerged({ ...patch, updated_at: new Date() } as Record<string, unknown>) as never)
    .where("id", "=", lineId)
    .where("order_id", "=", orderId)
    .returningAll()
    .executeTakeFirst();
  if (!row) return null;
  const was = said(before);
  const now = said(row);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(now) as Array<keyof typeof now>) if (was[k] !== now[k]) changed[k] = { from: was[k], to: now[k] };
  if (patch.metadata) changed.metadata = { from: null, to: patch.metadata };
  if (Object.keys(changed).length) {
    await orderHappened(db, orgId, orderId, { kind: "line", detail: { change: "changed", line_id: lineId, description: row.description, changed }, by_user: userId });
  }
  return row;
}

/** Null when the line is not on this order (or not on any, when orderId is
 *  not given, as the undo of add-line knows only the line). */
export async function removeLine(db: Db, orgId: string, userId: string | null, lineId: string, orderId?: string) {
  let q = db.deleteFrom("sales_order_items").where("id", "=", lineId);
  if (orderId) q = q.where("order_id", "=", orderId);
  const row = await q.returningAll().executeTakeFirst();
  if (!row) return null;
  await orderHappened(db, orgId, row.order_id, { kind: "line", detail: { change: "removed", line_id: row.id, ...said(row) }, by_user: userId });
  return row;
}
