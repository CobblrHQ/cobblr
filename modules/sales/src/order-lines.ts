// Adding, changing and removing an order's lines: one copy for the routes and
// the actions, each change on the order's timeline and in the workspace log
// (through orderHappened). A line that is not on the order is said to be not
// there, never answered as if it had been removed.

import { ActionRefusal } from "@cobblr/platform-contract/action-refusal";
import { withOrderLock } from "./order-lock.js";
import { withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
import type { Kysely } from "kysely";
import type { SalesDB } from "./db.js";
import { orderHappened, type HistoryLog } from "./history.js";
import { refreshHold, releaseLineHold } from "./holds.js";
import { settlePaidAfterLines } from "./payments.js";

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

/** As high as a return or a payment on the line can go, so what is sold can be paid. */
export const MOST_ON_A_LINE = 1_000_000;
export const MOST_A_LINE_COSTS = 100_000_000;

/** A line a door has to refuse, with the answer a route gives it. */
export class LineRefused extends ActionRefusal {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class LineStockRefusal extends LineRefused {
  constructor(message = "This line has already taken stock. Cancel the order to return its stock before removing the line.") {
    super("stock_already_taken", message);
  }
}

function refuseImpossibleNumbers(v: LineValues): void {
  if (v.qty !== undefined && !(Number.isFinite(v.qty) && v.qty > 0 && v.qty <= MOST_ON_A_LINE)) {
    throw new LineRefused("not_a_quantity", `How many is a number above zero, up to ${MOST_ON_A_LINE}.`, 400);
  }
  if (v.unit_price != null && !(Number.isFinite(v.unit_price) && Math.abs(v.unit_price) <= MOST_A_LINE_COSTS)) {
    throw new LineRefused("not_a_price", `The price each is a number, up to ${MOST_A_LINE_COSTS}.`, 400);
  }
}

export async function addLine(db: Db, orgId: string, userId: string | null, orderId: string, v: LineValues & { qty: number }, afterCommit?: Array<() => Promise<void>>, log?: HistoryLog) {
  refuseImpossibleNumbers(v);
  const row = await db
    .insertInto("sales_order_items")
    .values({ ...v, description: v.description?.trim() || null, order_id: orderId, metadata: v.metadata ?? {} } as never)
    .returningAll()
    .executeTakeFirstOrThrow();
  await orderHappened(db, orgId, orderId, { kind: "line", detail: { change: "added", line_id: row.id, ...said(row) }, by_user: userId }, afterCommit, log);
  if (!afterCommit) {
    await refreshHold(db, orgId, userId, orderId);
    await settlePaidAfterLines(db, orgId, orderId);
  }
  return row;
}

/** Null when the line is not on this order. The log keeps what each changed
 *  value was before. */
export async function changeLine(db: Db, orgId: string, userId: string | null, orderId: string, lineId: string, change: LineValues) {
  refuseImpossibleNumbers(change);
  const patch = typeof change.description === "string" ? { ...change, description: change.description.trim() || null } : change;
  return withOrderLock(db, orgId, userId, orderId, async () => {
    const before = await db.selectFrom("sales_order_items").selectAll().where("id", "=", lineId).where("order_id", "=", orderId).executeTakeFirst();
    if (!before) return null;
    if (patch.qty !== undefined && patch.qty > Number(before.qty)) {
      const order = await db.selectFrom("sales_orders").select("status").where("id", "=", orderId).executeTakeFirst();
      if (order && (order.status === "fulfilled" || order.status === "shipped" || order.status === "closed")) {
        throw new ActionRefusal(`This order is already ${order.status}. Cancel the order to return stock before increasing its line quantity.`);
      }
    }
    const taken = Number(before.qty_fulfilled);
    if (patch.qty !== undefined && patch.qty < taken) {
      throw new ActionRefusal(`This line has already taken ${taken} from stock. Its quantity cannot be less than ${taken}. Cancel the order to return stock first.`);
    }
    // A cancel puts stock back on the line's part: another part would gain what it never lost, and none would lose it for good.
    if (patch.part_id !== undefined && patch.part_id !== before.part_id && taken > 0) {
      throw new LineStockRefusal(`This line has already taken ${taken} from stock, so it stays on that part. Cancel the order to return the stock first.`);
    }
    const partAfter = patch.part_id !== undefined ? patch.part_id : before.part_id;
    const saysAfter = patch.description !== undefined ? patch.description : before.description;
    if (!partAfter && !saysAfter && (patch.part_id !== undefined || patch.description !== undefined)) {
      throw new LineRefused("nothing_on_the_line", "Say what is being sold: a description, or a part you track.", 400);
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
    await refreshHold(db, orgId, userId, orderId, true);
    await settlePaidAfterLines(db, orgId, orderId);
    return row;
  });
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
    await releaseLineHold(db, orgId, userId, found.order_id, lineId);
    const row = await db.deleteFrom("sales_order_items").where("id", "=", lineId).where("order_id", "=", found.order_id).returningAll().executeTakeFirst();
    if (!row) return null;
    await orderHappened(db, orgId, row.order_id, { kind: "line", detail: { change: "removed", line_id: row.id, ...said(row) }, by_user: userId });
    await refreshHold(db, orgId, userId, row.order_id, true);
    await settlePaidAfterLines(db, orgId, row.order_id);
    return row;
  });
}
