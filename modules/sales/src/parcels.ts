// A sales order's parcels (#9505): one box of an order, with its own tracking
// number, carrier and date, and the lines and counts it carries.
//
// Stock taken out for a line (qty_fulfilled) is not a parcel. It reads "taken
// from stock" until a parcel carries it, and the order reads shipped only when
// every stocked line is wholly in parcels. The purchases side keeps the same
// shape (purchases_order_shipments), so there is one way an order's boxes are
// told, not two.
//
// Every writer here runs under the order's lock (withOrderLock), as Fulfill and
// Ship do: two people pressing at once must not put one unit in two boxes.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { SalesDB, SalesOrderStatus } from "./db.js";
import { orderHappened } from "./history.js";
import { withOrderLock } from "./order-lock.js";

export interface ParcelLine {
  item_id: string;
  description: string | null;
  qty: number;
}

export interface Parcel {
  id: string;
  tracking_number: string | null;
  carrier: string | null;
  shipped_at: string;
  lines: ParcelLine[];
}

const num = (v: unknown): number => Number(v) || 0;

/** How many of each line are in a parcel, by line id. */
export async function parcelledByLine(db: Kysely<SalesDB>, orderId: string): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom("sales_order_parcel_lines as pl")
    .innerJoin("sales_order_parcels as p", "p.id", "pl.parcel_id")
    .select(["pl.item_id", sql<string>`sum(pl.qty)`.as("qty")])
    .where("p.order_id", "=", orderId)
    .groupBy("pl.item_id")
    .execute();
  return new Map(rows.map((r) => [r.item_id, num(r.qty)]));
}

/** The order's parcels, oldest first, each with what it carries. */
export async function listParcels(db: Kysely<SalesDB>, orderId: string): Promise<Parcel[]> {
  const parcels = await db.selectFrom("sales_order_parcels").selectAll().where("order_id", "=", orderId).orderBy("shipped_at").orderBy("created_at").execute();
  if (parcels.length === 0) return [];
  const lines = await db
    .selectFrom("sales_order_parcel_lines as pl")
    .innerJoin("sales_order_items as i", "i.id", "pl.item_id")
    .select(["pl.parcel_id", "pl.item_id", "pl.qty", "i.description"])
    .where("pl.parcel_id", "in", parcels.map((p) => p.id))
    .orderBy("i.created_at")
    .execute();
  return parcels.map((p) => ({
    id: p.id,
    tracking_number: p.tracking_number,
    carrier: p.carrier,
    shipped_at: new Date(p.shipped_at).toISOString(),
    lines: lines.filter((l) => l.parcel_id === p.id).map((l) => ({ item_id: l.item_id, description: l.description, qty: num(l.qty) })),
  }));
}

/** Stock taken out and not yet in any parcel, per stocked line. */
export async function unparcelled(db: Kysely<SalesDB>, orderId: string): Promise<Array<{ item_id: string; description: string | null; qty: number }>> {
  const items = await db.selectFrom("sales_order_items").select(["id", "description", "part_id", "qty_fulfilled"]).where("order_id", "=", orderId).orderBy("created_at").execute();
  const inParcels = await parcelledByLine(db, orderId);
  const out: Array<{ item_id: string; description: string | null; qty: number }> = [];
  for (const i of items) {
    if (!i.part_id) continue;
    const left = num(i.qty_fulfilled) - (inParcels.get(i.id) ?? 0);
    if (left > 0) out.push({ item_id: i.id, description: i.description, qty: left });
  }
  return out;
}

/** True when every stocked line is wholly in parcels (a line with no part has no stock to send). */
export async function everyLineInParcels(db: Kysely<SalesDB>, orderId: string): Promise<boolean> {
  const items = await db.selectFrom("sales_order_items").select(["id", "part_id", "qty"]).where("order_id", "=", orderId).execute();
  const inParcels = await parcelledByLine(db, orderId);
  return items.every((i) => !i.part_id || (inParcels.get(i.id) ?? 0) >= num(i.qty));
}

export type ParcelResult =
  | { ok: true; parcel_id: string; created: boolean; shipped: boolean; status: SalesOrderStatus; lines: Array<{ description: string | null; qty: number }>; carrier: string | null; tracking_number: string | null }
  | { ok: false; code: "not_found" | "cancelled" | "nothing_to_put_in_a_parcel" | "more_than_taken"; message: string };

export interface ParcelArgs {
  /** The lines and counts this box carries; default every line's stock that is not in a box yet. */
  lines?: Array<{ item_id: string; qty: number }> | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  userId: string | null;
}

/** Put stock that has left into one parcel, under the order's lock. The same tracking number twice adds to that parcel. When this puts
 *  the last line into a parcel, the order is shipped, carrying this parcel's tracking and carrier as it always did. */
export async function recordParcelUnderLock(db: Kysely<SalesDB>, orgId: string, orderId: string, args: ParcelArgs): Promise<ParcelResult> {
  const order = await db.selectFrom("sales_orders").select(["id", "status"]).where("id", "=", orderId).executeTakeFirst();
  if (!order) return { ok: false, code: "not_found", message: "That order is not here any more." };
  if (order.status === "cancelled") return { ok: false, code: "cancelled", message: "A cancelled order does not ship." };

  const open = await unparcelled(db, orderId);
  const room = new Map(open.map((l) => [l.item_id, l]));
  let take: Array<{ item_id: string; description: string | null; qty: number }>;
  if (args.lines && args.lines.length > 0) {
    take = [];
    for (const l of args.lines) {
      const have = room.get(l.item_id);
      const qty = Math.floor(num(l.qty));
      if (!have || qty <= 0) return { ok: false, code: "nothing_to_put_in_a_parcel", message: "That line has no stock taken out that is not already in a parcel." };
      if (qty > have.qty) return { ok: false, code: "more_than_taken", message: `Only ${have.qty} of ${have.description ?? "that line"} ${have.qty === 1 ? "is" : "are"} out of stock and not yet in a parcel.` };
      take.push({ item_id: l.item_id, description: have.description, qty });
    }
  } else {
    take = open;
  }
  if (take.length === 0) return { ok: false, code: "nothing_to_put_in_a_parcel", message: "Nothing has been taken from stock that is not already in a parcel." };

  const tracking = args.trackingNumber?.trim() || null;
  const carrier = args.carrier?.trim() || null;
  const existing = tracking ? await db.selectFrom("sales_order_parcels").select("id").where("order_id", "=", orderId).where("tracking_number", "=", tracking).executeTakeFirst() : undefined;
  let parcelId: string;
  if (existing) {
    parcelId = existing.id;
    await db.updateTable("sales_order_parcels").set({ ...(carrier ? { carrier } : {}), updated_at: new Date() } as never).where("id", "=", parcelId).execute();
  } else {
    const row = await db.insertInto("sales_order_parcels").values({ order_id: orderId, tracking_number: tracking, carrier, created_by: args.userId }).returning("id").executeTakeFirstOrThrow();
    parcelId = row.id;
  }
  for (const l of take) {
    await sql`insert into sales_order_parcel_lines (parcel_id, item_id, qty) values (${parcelId}, ${l.item_id}, ${l.qty})
      on conflict (parcel_id, item_id) do update set qty = sales_order_parcel_lines.qty + excluded.qty`.execute(db);
  }

  const lines = take.map((l) => ({ description: l.description, qty: l.qty }));
  await orderHappened(db, orgId, orderId, { kind: "shipped", detail: { parcel_id: parcelId, carrier, tracking_number: tracking, lines, partial: !(await everyLineInParcels(db, orderId)) }, by_user: args.userId });

  let status = order.status;
  let shipped = false;
  if (order.status === "fulfilled" && (await everyLineInParcels(db, orderId))) {
    await db.updateTable("sales_orders").set({ status: "shipped", carrier, tracking_number: tracking, shipped_at: new Date(), updated_at: new Date() } as never).where("id", "=", orderId).execute();
    await orderHappened(db, orgId, orderId, { kind: "status", from_status: "fulfilled", to_status: "shipped", by_user: args.userId });
    status = "shipped";
    shipped = true;
    void platform().events.emit("sales.order.shipped", { orgId, orderId, carrier, trackingNumber: tracking });
  }
  return { ok: true, parcel_id: parcelId, created: !existing, shipped, status, lines, carrier, tracking_number: tracking };
}

/** The same, taking the order's lock (the action and the route). */
export async function recordParcel(db: Kysely<SalesDB>, orgId: string, orderId: string, args: ParcelArgs): Promise<ParcelResult> {
  return withOrderLock(db, orgId, args.userId, orderId, () => recordParcelUnderLock(db, orgId, orderId, args));
}

/** Give a parcel the tracking number (and carrier) a person has now. Refuses a number another parcel of this order already has. */
export async function setParcelTracking(
  db: Kysely<SalesDB>,
  orgId: string,
  orderId: string,
  parcelId: string,
  args: { trackingNumber: string; carrier?: string | null; userId: string | null },
): Promise<{ ok: true; tracking_number: string; carrier: string | null } | { ok: false; code: "not_found" | "duplicate"; message: string }> {
  return withOrderLock(db, orgId, args.userId, orderId, async () => {
    const parcel = await db.selectFrom("sales_order_parcels").select(["id", "carrier"]).where("id", "=", parcelId).where("order_id", "=", orderId).executeTakeFirst();
    if (!parcel) return { ok: false, code: "not_found", message: "That parcel is not on this order." };
    const tracking = args.trackingNumber.trim();
    const clash = await db.selectFrom("sales_order_parcels").select("id").where("order_id", "=", orderId).where("tracking_number", "=", tracking).where("id", "!=", parcelId).executeTakeFirst();
    if (clash) return { ok: false, code: "duplicate", message: "Another parcel of this order already has that tracking number." };
    const carrier = args.carrier?.trim() || parcel.carrier;
    await db.updateTable("sales_order_parcels").set({ tracking_number: tracking, carrier, updated_at: new Date() } as never).where("id", "=", parcelId).execute();
    await orderHappened(db, orgId, orderId, { kind: "shipped", detail: { parcel_id: parcelId, carrier, tracking_number: tracking, tracking_added: true }, by_user: args.userId });
    const only = await db.selectFrom("sales_orders").select(["status", "tracking_number"]).where("id", "=", orderId).executeTakeFirst();
    if (only?.status === "shipped" && !only.tracking_number) {
      await db.updateTable("sales_orders").set({ tracking_number: tracking, carrier, updated_at: new Date() } as never).where("id", "=", orderId).execute();
    }
    return { ok: true, tracking_number: tracking, carrier };
  });
}
