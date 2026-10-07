// A scanned distributor package receives the order line it was bought on.
//
// A component order planned from a board's shortage list is counted by scan,
// not on arrival (add_to_stock off): each package's 2D label creates or tops up
// its stock in inventory. Nothing told the order, so it stayed "planned" after
// every reel was on the shelf, and the arrival sweep went on asking whether it
// had turned up. Inventory now says what it received (inventory.package.received,
// with the label's distributor, MPN, quantity and customer PO); this finds the
// open order from that distributor with a line for that part, adds the package
// to the line's scanned count, receives the line once the count covers it, and
// marks the order arrived when its last line is received.
//
// The label's customer PO picks the order when it matches one; otherwise the
// oldest open order from the distributor with an unreceived line for the part.
// A package nobody ordered matches nothing and changes nothing. Each receipt is
// counted once (its receipt key is remembered on the line), so a redelivered
// event cannot receive a line early.

import { sql, type Kysely } from "kysely";
import { arrivedEverywhere, likeEscape, platform } from "@cobblr/platform-contract";
import type { PurchasesDB } from "./db.js";
import { receiveOrderLine } from "./receive.js";

export interface PackageReceived {
  orgId: string;
  receiptKey: string;
  partId: string;
  typeId: string;
  mpn: string;
  quantity: number;
  distributor: string | null;
  purchaseOrder: string | null;
  receivedBy: string | null;
}

interface Candidate {
  line_id: string;
  order_id: string;
  qty: string | null;
  metadata: Record<string, unknown>;
}

/** Count one received package against its order line. Answers the line it
 *  counted against, or null when no open order bought it. */
export async function countPackageAgainstOrder(db: Kysely<PurchasesDB>, p: PackageReceived, now = new Date()): Promise<{ orderId: string; lineId: string; lineReceived: boolean; orderArrived: boolean } | null> {
  if (!p.distributor || !p.mpn.trim()) return null;
  const mpn = p.mpn.trim().toLowerCase();
  const counted = await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`package-arrival:${p.distributor!.toLowerCase()}:${mpn}`}, 0))`.execute(trx);
    const rows = await sql<Candidate>`
      select i.id::text as line_id, o.id::text as order_id, i.qty::text as qty, i.metadata
        from purchases_order_items i
        join purchases_orders o on o.id = i.order_id
       where o.status not in ('arrived', 'cancelled')
         and o.arrived_at is null
         and lower(btrim(o.vendor)) = ${p.distributor!.trim().toLowerCase()}
         and i.received_at is null
         and (i.part_id = ${p.typeId}::uuid
              or lower(btrim(coalesce(i.description, ''))) = ${mpn}
              or lower(btrim(coalesce(i.description, ''))) like ${`% ${likeEscape(mpn)}`})
       order by (${p.purchaseOrder ?? ""} <> '' and lower(coalesce(o.order_number, '')) = ${(p.purchaseOrder ?? "").toLowerCase()}) desc,
                o.created_at asc, i.created_at asc
       limit 1
       for update of i`.execute(trx);
    const line = rows.rows[0];
    if (!line) return null;
    const seen = Array.isArray(line.metadata.scanned_receipts) ? (line.metadata.scanned_receipts as string[]) : [];
    if (seen.includes(p.receiptKey)) return { ...line, covered: false, repeat: true };
    const scanned = Number(line.metadata.scanned_qty ?? 0) + p.quantity;
    await trx
      .updateTable("purchases_order_items")
      .set({ metadata: { ...line.metadata, scanned_qty: scanned, scanned_receipts: [...seen, p.receiptKey] } })
      .where("id", "=", line.line_id)
      .execute();
    return { ...line, covered: scanned >= Number(line.qty ?? 0), repeat: false };
  });
  if (!counted || counted.repeat) return counted ? { orderId: counted.order_id, lineId: counted.line_id, lineReceived: false, orderArrived: false } : null;

  const on = arrivedEverywhere(now);
  const lineReceived = counted.covered ? await receiveOrderLine(db, p.orgId, counted.line_id, on, p.typeId) : false;
  if (lineReceived) {
    await platform().activity.log({
      orgId: p.orgId, userId: p.receivedBy, action: "order_item_received",
      ref: { module: "purchases", entityType: "order", entityId: counted.order_id },
      diff: { line: counted.line_id, mpn: p.mpn, by: "package scan" },
    });
  }
  const open = await db.selectFrom("purchases_order_items").select("id").where("order_id", "=", counted.order_id).where("received_at", "is", null).executeTakeFirst();
  let orderArrived = false;
  if (!open) {
    const res = (await platform().actions.invoke("purchases:mark-arrived", {
      orgId: p.orgId,
      userId: p.receivedBy,
      args: { orderId: counted.order_id, arrivedOn: on },
      event: { name: "inventory.package.received", payload: {}, actor: { user_id: p.receivedBy, display_name: null, auth_method: "system" }, timestamp: now.toISOString(), trigger_type: "event" },
    })) as { ok?: boolean; skipped?: string } | null;
    orderArrived = res?.ok === true && !res.skipped;
  }
  return { orderId: counted.order_id, lineId: counted.line_id, lineReceived, orderArrived };
}

export function registerPackageArrivals(): void {
  platform().events.on("inventory.package.received", "purchases", async (payload: unknown) => {
    const p = payload as Partial<PackageReceived>;
    if (!p.orgId || !p.receiptKey || !p.typeId || !p.mpn || typeof p.quantity !== "number") return;
    const db = (await platform().tenants.getDb(p.orgId)) as Kysely<PurchasesDB>;
    await countPackageAgainstOrder(db, p as PackageReceived);
  });
}
