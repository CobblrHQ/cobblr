// Change an order line (sales:change-line): the handler its manifest entry names. Wired in ./index.ts.
// The same change as editing a line on the order (PATCH /orders/:id/items/:itemId).
// Not undoable on purpose: an order is a financial record, so it always asks first.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { changeLine } from "../order-lines.js";

export function registerChangeLineAction(): void {
  platform().actions.registerHandler("sales.change-line", async (ctx) => {
    const order = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const want = typeof a.line === "string" ? a.line.trim() : "";
    const patch: { qty?: number; unit_price?: number | null; description?: string | null } = {};
    if (a.qty !== undefined && a.qty !== "") {
      const qty = Number(a.qty);
      if (!(qty > 0)) return { ok: false, error: "How many is more than zero." };
      patch.qty = qty;
    }
    if (a.unit_price !== undefined) patch.unit_price = a.unit_price === null || a.unit_price === "" ? null : Number(a.unit_price);
    if (typeof a.description === "string") patch.description = a.description.trim().slice(0, 500) || null;
    if (!Object.keys(patch).length) return { ok: false, error: "Say what to change: how many, the price each, or what it says." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const lines = await db.selectFrom("sales_order_items").select(["id", "description", "qty"]).where("order_id", "=", order.id).execute();
    const hit = want ? lines.filter((l) => l.id === want || (l.description ?? "").toLowerCase() === want.toLowerCase()) : lines.length === 1 ? lines : [];
    if (hit.length !== 1) return { ok: false, error: lines.length ? `Say which line: ${lines.map((l) => l.description ?? l.id).join(", ")}.` : "This order has no lines." };
    const row = await changeLine(db, ctx.orgId, ctx.userId, order.id, hit[0]!.id, patch);
    if (!row) return { ok: false, error: "That line is gone." };
    return { ok: true, summary: `Changed the line${row.description ? ` for ${row.description}` : ""}: ${Number(row.qty)} at ${row.unit_price == null ? "no price" : row.unit_price} each.`, data: { line: row.id } };
  });
}
