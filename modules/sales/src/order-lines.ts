// Adding, changing and removing an order's lines: one copy for the routes and
// the actions, each change on the order's timeline and in the workspace log
// (through orderHappened). A line that is not on the order is said to be not
// there, never answered as if it had been removed.

import { ActionRefusal } from "@cobblr/platform-contract/action-refusal";
import { withOrderLock } from "./order-lock.js";
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

export async function addLine(db: Db, orgId: string, userId: string | null, orderId: string, v: LineValues & { qty: number }, afterCommit?: Array<() => Promise<void>>) {
  const row = await db
    .insertInto("sales_order_items")
    .values({ ...v, order_id: orderId, metadata: v.metadata ?? {} } as never)
    .returningAll()
    .executeTakeFirstOrThrow();
  await orderHappened(db, orgId, orderId, { kind: "line", detail: { change: "added", line_id: row.id, ...said(row) }, by_user: userId }, afterCommit);
  return row;
}

/** Null when the line is not on this order. The log keeps what each changed
 *  value was before. */
export async function changeLine(db: Db, orgId: string, userId: string | null, orderId: string, lineId: string, patch: LineValues) {
  return withOrderLock(db, orgId, userId, orderId, async () => {
    const before = await db.selectFrom("sales_order_items").selectAll().where("id", "=", lineId).where("order_id", "=", orderId).executeTakeFirst();
    if (!before) return null;
    const taken = Number(before.qty_fulfilled);
    if (patch.qty !== undefined && patch.qty < taken) {
      throw new ActionRefusal(`This line has already taken ${taken} from stock. Its quantity cannot be less than ${taken}. Cancel the order to return stock first.`);
    }
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
  });
}

export class LineStockRefusal extends ActionRefusal {
  readonly code = "stock_already_taken";
  constructor() {
    super("This line has already taken stock. Cancel the order to return its stock before removing the line.");
  }
}

/** Null when the line is not on this order (or not on any, when orderId is
 *  not given, as the undo of add-line knows only the line). */
export async function removeLine(db: Db, orgId: string, userId: string | null, lineId: string, orderId?: string) {
  let find = db.selectFrom("sales_order_items").select("order_id").where("id", "=", lineId);
  if (orderId) find = find.where("order_id", "=", orderId);
  const found = await find.executeTakeFirst();
  if (!found) return null;
  return withOrderLock(db, orgId, userId, found.order_id, async () => {
    const before = await db.selectFrom("sales_order_items").selectAll().where("id", "=", lineId).where("order_id", "=", found.order_id).executeTakeFirst();
    if (!before) return null;
    if (Number(before.qty_fulfilled) > 0) throw new LineStockRefusal();
    const row = await db.deleteFrom("sales_order_items").where("id", "=", lineId).where("order_id", "=", found.order_id).returningAll().executeTakeFirst();
    if (!row) return null;
    await orderHappened(db, orgId, row.order_id, { kind: "line", detail: { change: "removed", line_id: row.id, ...said(row) }, by_user: userId });
    return row;
  });
}
