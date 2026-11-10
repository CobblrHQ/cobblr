import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { PurchasesDB } from "../db.js";

// A new vendor's Undo (#9383). Deleting a vendor lets go of it on every order
// naming it (on delete set null), so an Undo pressed after a purchase was
// saved with it took that shop off the order and its spend read under nobody.
// It removes the vendor only while no order names it, and says why when one
// does. Made from an order's own field, that order is the one exception:
// the Undo takes the vendor off it again. Issued only to the person who made it (vendors.ts), so a member takes
// back their own new vendor; deleting any other vendor stays an admin's.
export function registerTakeBackVendor(): void {
  platform().actions.registerHandler("purchases.take-back-vendor", async (ctx) => {
    const args = (ctx.args ?? {}) as { vendor_id?: unknown; order_id?: unknown };
    const id = String(args.vendor_id ?? "").trim();
    const ownOrder = typeof args.order_id === "string" && args.order_id ? args.order_id : null;
    if (!id) return { ok: false, error: "missing vendor_id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<PurchasesDB>;
    return platform().activity.transaction(ctx.orgId, db, async (trx, log) => {
      let others = trx.selectFrom("purchases_orders").select(({ fn }) => fn.countAll<string>().as("n")).where("vendor_id", "=", id);
      if (ownOrder) others = others.where("id", "!=", ownOrder);
      const n = Number((await others.executeTakeFirst())?.n ?? 0);
      if (n > 0) {
        const which = ownOrder ? (n === 1 ? "another order names" : `${n} other orders name`) : n === 1 ? "an order names" : `${n} orders name`;
        return { ok: false, error: `Kept: ${which} this vendor now, so taking it away would leave ${n === 1 ? "that order" : "them"} without a shop.` };
      }
      // The order it was made for keeps the shop's name as text, as before it was a vendor.
      if (ownOrder) await trx.updateTable("purchases_orders").set({ vendor_id: null }).where("id", "=", ownOrder).where("vendor_id", "=", id).execute();
      const gone = await trx.deleteFrom("purchases_vendors").where("id", "=", id).returning(["id", "name"]).executeTakeFirst();
      if (!gone) return { ok: true, skipped: true, reason: "already gone" };
      await log({ orgId: ctx.orgId, userId: ctx.userId ?? null, action: "vendor_deleted", ref: { module: "purchases", entityType: "vendor", entityId: id }, diff: {} });
      return { ok: true, summary: `Took back ${gone.name}.`, removed: gone.id };
    });
  });
}
