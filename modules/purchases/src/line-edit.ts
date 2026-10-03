import { withMetadataMerged } from "@cobblr/platform-contract/entity-metadata";
// Correcting one line of an order: what it is, how many, the price. The order
// page and Cobb's purchases:edit-line both come through here, so both answer
// the same way.
//
// A line whose stock was already added keeps its count. Changing it here
// would leave the shelf at the old number with nothing to explain the
// difference; the item's own count is where that correction belongs, and its
// history then says why.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { PurchasesDB, PurchasesOrderItemsTable } from "./db.js";

export interface LineEdit {
  description?: string | null;
  qty?: number;
  unit_cost?: number | null;
  currency?: string;
}

export type LineEditResult =
  | { ok: true; line: Record<string, unknown>; before: Required<Omit<LineEdit, "currency">> }
  | { ok: false; code: "not_found" | "line_received"; message: string };

export const LINE_RECEIVED_MESSAGE = "This line's stock was already added. Change the item's count instead, so its history says why.";

export async function editOrderLine(
  db: Kysely<PurchasesDB>,
  who: { orgId: string; userId: string | null },
  lineId: string,
  edit: LineEdit,
  orderId?: string,
): Promise<LineEditResult> {
  let q = db
    .selectFrom("purchases_order_items as i")
    .innerJoin("purchases_orders as o", "o.id", "i.order_id")
    .select(["i.order_id", "i.qty", "i.description", "i.unit_cost", "i.received_at", "i.part_id", "o.add_to_stock", "i.metadata"])
    .where("i.id", "=", lineId);
  if (orderId) q = q.where("i.order_id", "=", orderId);
  const line = await q.executeTakeFirst();
  if (!line) return { ok: false, code: "not_found", message: "order line not found" };
  if (edit.qty !== undefined && Number(edit.qty) !== Number(line.qty) && line.received_at && line.part_id && line.add_to_stock !== false) {
    return { ok: false, code: "line_received", message: LINE_RECEIVED_MESSAGE };
  }
  const set: Partial<Record<keyof PurchasesOrderItemsTable, unknown>> = { updated_at: new Date() };
  if (edit.description !== undefined) set.description = edit.description;
  if (edit.qty !== undefined) set.qty = edit.qty;
  if (edit.unit_cost !== undefined) set.unit_cost = edit.unit_cost;
  if (edit.currency !== undefined) set.metadata = { currency: edit.currency };
  const updated = await db.updateTable("purchases_order_items").set(withMetadataMerged(set) as never).where("id", "=", lineId).returningAll().executeTakeFirstOrThrow();
  await platform().activity.log({
    orgId: who.orgId,
    userId: who.userId,
    action: "order_item_updated",
    ref: { module: "purchases", entityType: "order_item", entityId: lineId },
    diff: { order_id: line.order_id, ...edit },
    before: line,
  });
  const before = { description: line.description, qty: Number(line.qty), unit_cost: line.unit_cost == null ? null : Number(line.unit_cost) };
  return { ok: true, line: updated as unknown as Record<string, unknown>, before };
}
