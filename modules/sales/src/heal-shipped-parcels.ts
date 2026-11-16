// One-shot heal: an order that shipped before orders kept parcels (#9505) gets the one parcel it went in.
//
// DONE WHEN: no sales_orders row made before `since`, with a shipped or closed status and stock taken out, lacks a
// sales_order_parcels row. Check prod, staging and dev, then delete this file and its onBoot call.
//
// BORN WITH: ship.ts and parcels.ts record a parcel whenever stock leaves in a box and whenever Ship finishes an order, so an
// order shipped now already has its parcel, and a shipped order's lines read "shipped", not "taken from stock".
//
// WHY IT EXISTS: a line reads "taken from stock" until a parcel carries it. Without this, every order already shipped would read
// that way after the update, as if it had not gone out. The parcel carries what was taken out, with the order's own carrier,
// tracking number and ship date.

import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { Kysely } from "kysely";
import type { SalesDB } from "./db.js";
import { withOrderLock } from "./order-lock.js";

/** Give one shipped order its parcel, under its lock. True when it made one. */
async function parcelOf(db: Kysely<SalesDB>, orgId: string, orderId: string): Promise<boolean> {
  return withOrderLock(db, orgId, null, orderId, async () => {
    const has = await db.selectFrom("sales_order_parcels").select("id").where("order_id", "=", orderId).executeTakeFirst();
    if (has) return false;
    const order = await db.selectFrom("sales_orders").select(["carrier", "tracking_number", "shipped_at", "updated_at"]).where("id", "=", orderId).executeTakeFirst();
    if (!order) return false;
    const lines = await db.selectFrom("sales_order_items").select(["id", "qty_fulfilled"]).where("order_id", "=", orderId).where("part_id", "is not", null).where("qty_fulfilled", ">", "0").execute();
    if (lines.length === 0) return false;
    const parcel = await db
      .insertInto("sales_order_parcels")
      .values({ order_id: orderId, tracking_number: order.tracking_number, carrier: order.carrier, shipped_at: order.shipped_at ?? order.updated_at, created_by: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const l of lines) await db.insertInto("sales_order_parcel_lines").values({ parcel_id: parcel.id, item_id: l.id, qty: Number(l.qty_fulfilled) }).execute();
    return true;
  });
}

export async function healShippedParcels(db: Kysely<SalesDB>, orgId: string, since: Date): Promise<number> {
  const orders = await db
    .selectFrom("sales_orders")
    .select("id")
    .where("status", "in", ["shipped", "closed"])
    .where("created_at", "<", since)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom("sales_order_parcels").select("sales_order_parcels.id").whereRef("sales_order_parcels.order_id", "=", "sales_orders.id"))))
    .execute();
  let healed = 0;
  for (const o of orders) if (await parcelOf(db, orgId, o.id)) healed++;
  return healed;
}

export function registerShippedParcelsHeal(): void {
  registerHealPass({
    name: "sales.shipped-order-parcels",
    since: "2026-11-17T06:00:00Z",
    shim: "modules/sales/src/heal-shipped-parcels.ts",
    module: "sales",
    visit: ({ db, orgId, since }) => healShippedParcels(db as Kysely<SalesDB>, orgId, since),
  });
}
