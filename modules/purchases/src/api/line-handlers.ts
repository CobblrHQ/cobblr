// purchases:add-line — put a line on an existing order.
//
// draft-po creates an order with its lines and mark-arrived closes one, and
// between the two there was no way to say "add two more of those to the order I
// already raised". That is an ordinary thing to ask for.
//
// Removing a line has no door on purpose: an order is a financial record, and
// deleting a line by voice is the kind of thing you want to see before it
// happens. Editing the order in the app is one tap.

import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { PurchasesDB } from "../db.js";

export function registerLineHandlers(): void {
  platform().actions.registerHandler("purchases.add-line", async (ctx) => {
    const order = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const qty = typeof args.qty === "number" ? args.qty : Number(args.qty);
    if (!Number.isFinite(qty) || qty === 0) return { ok: false, error: "say how many (qty)" };

    const description = typeof args.description === "string" ? args.description.trim() : "";
    const partId = typeof args.part_id === "string" && args.part_id.trim() ? args.part_id.trim() : null;
    if (!description && !partId) {
      return { ok: false, error: "say what the line is for: a description, or part_id for a part you already track" };
    }
    const unitCost = typeof args.unit_cost === "number" ? args.unit_cost : null;

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<PurchasesDB>;
    const exists = await db
      .selectFrom("purchases_orders")
      .select("id")
      .where("id", "=", order.id)
      .executeTakeFirst();
    if (!exists) return { ok: false, error: "that order no longer exists" };

    const row = await db
      .insertInto("purchases_order_items")
      .values({
        order_id: order.id,
        part_id: partId,
        description: description || null,
        qty,
        unit_cost: unitCost,
        metadata: {},
      } as never)
      .returning(["id", "qty", "description"])
      .executeTakeFirstOrThrow();

    await platform().activity.log({
      orgId: ctx.orgId,
      userId: ctx.userId,
      action: "order_item_added",
      ref: { module: "purchases", entityType: "order_item", entityId: row.id },
      diff: { qty, description: description || null, part_id: partId },
    });
    return { ok: true, result: { line_id: row.id, qty: row.qty, description: row.description } };
  });
}
