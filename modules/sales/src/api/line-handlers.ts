// sales:add-line — put a line on an existing order.
//
// create-order builds one with its lines and fulfill-order closes it; adding to
// an order already raised had no door. Same shape, and the same reasoning, as
// purchases:add-line — including leaving removal to the app, because an order
// is a financial record.

import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";

export function registerSalesLineHandlers(): void {
  registerUndos();
  platform().actions.registerHandler("sales.add-line", async (ctx) => {
    const order = requireActionEntity(ctx);
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const qty = typeof args.qty === "number" ? args.qty : Number(args.qty);
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "say how many (a positive qty)" };

    const description = typeof args.description === "string" ? args.description.trim() : "";
    const partId = typeof args.part_id === "string" && args.part_id.trim() ? args.part_id.trim() : null;
    if (!description && !partId) {
      return { ok: false, error: "say what is being sold: a description, or part_id for a part you track" };
    }
    const unitPrice = typeof args.unit_price === "number" ? args.unit_price : null;

    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const exists = await db
      .selectFrom("sales_orders")
      .select("id")
      .where("id", "=", order.id)
      .executeTakeFirst();
    if (!exists) return { ok: false, error: "that order no longer exists" };

    const row = await db
      .insertInto("sales_order_items")
      .values({
        order_id: order.id,
        part_id: partId,
        description: description || null,
        qty,
        unit_price: unitPrice,
        metadata: {},
      } as never)
      .returning(["id", "qty", "description"])
      .executeTakeFirstOrThrow();
    return { ok: true, result: { line_id: row.id, qty: row.qty, description: row.description } };
  });
}

function registerUndos(): void {
  platform().actions.registerHandler("sales.remove-line", async (ctx) => {
    const id = String((ctx.args as { line_id?: unknown } | null)?.line_id ?? "").trim();
    if (!id) return { ok: false, error: "missing line_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const row = await db.deleteFrom("sales_order_items").where("id", "=", id).returning(["id", "description"]).executeTakeFirst();
    if (!row) return { ok: true, skipped: true, reason: "already gone" };
    return { ok: true, summary: `Removed the line${row.description ? ` for ${row.description}` : ""}.`, removed: row.id };
  });
  platform().actions.registerUndo("sales.add-line", (result) => {
    const r = result as { ok?: unknown; result?: { line_id?: unknown } } | null;
    if (r?.ok !== true || typeof r.result?.line_id !== "string") return null;
    return { action_id: "sales:remove-line", args: { line_id: r.result.line_id } };
  });
}
