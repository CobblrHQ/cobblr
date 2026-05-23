// Action handlers — the wire-engine-callable side of inventory.
//
// Today: inventory.adjust-stock. The platform's wire engine calls
// this when a binding for action_id "inventory:adjust-stock" fires.
// Reads partId + delta from ctx.event.payload (or ctx.args), does
// an UPDATE inventory_parts SET qty = qty + delta, then re-emits
// inventory.stock.changed so downstream wires (set-dep-satisfied,
// notifications) still fire.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";

let registered = false;

interface AdjustStockPayload {
  partId?: string;
  delta?: number;
  reason?: string;
}

export function registerInventoryActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("inventory.adjust-stock", async (ctx) => {
    // Args take precedence (an admin can hardwire a wire to "always
    // add 1"); otherwise we pull from the event payload.
    const args = (ctx.args as AdjustStockPayload | null) ?? {};
    const ev = (ctx.event?.payload as AdjustStockPayload | null) ?? {};
    const partId = args.partId ?? ev.partId;
    const delta = args.delta ?? ev.delta;
    const reason = args.reason ?? ev.reason ?? "wire-driven adjustment";
    if (!partId || typeof delta !== "number" || delta === 0) {
      return { ok: true, skipped: true, reason: "missing partId or delta" };
    }
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const updated = await db
      .updateTable("inventory_parts")
      .set({
        qty: sql<string>`qty + ${delta}::numeric`,
        updated_at: new Date(),
      })
      .where("id", "=", partId)
      .returning(["id", "name", "qty"])
      .executeTakeFirst();
    if (!updated) return { ok: false, error: "part_not_found" };
    // Re-emit the stock-changed event so the existing
    // wire-of-record (inventory.stock.changed → projects.set-dep-
    // satisfied) keeps working — this action is additive, not a
    // replacement for the direct HTTP stock-adjust.
    await platform().events.emit("inventory.stock.changed", {
      orgId: ctx.orgId,
      partId: updated.id,
      delta,
      newQty: Number(updated.qty),
      reason,
    });
    return {
      ok: true,
      partId: updated.id,
      delta,
      newQty: Number(updated.qty),
    };
  });
}
