// Receiving an order's lines: the one place it happens, whichever door said
// the order arrived (the status dropdown, "Mark arrived", the "did it turn
// up?" sweeper, a parcel tracker).
//
// Two doors used to do this each their own way. "Mark arrived" emitted the
// received event with `qty` while the stock wire reads `delta`, so the wire
// skipped and nothing was added: the order said arrived, the shelf said
// empty. And nothing remembered a line had been received, so an order set back
// to ordered and then arrived again added its stock a second time. Here a
// line is received exactly once: its received_at is stamped in the same
// statement that picks it, and only lines still unstamped are picked, so a
// second arrival, a retry, or two doors at once find nothing left to add.

import { sql, type Kysely } from "kysely";
import { arrivedEverywhere, platform } from "@cobblr/platform-contract";
import type { PurchasesDB } from "./db.js";

import { ORDER_ITEM_RECEIVED_KEYS } from "./receive-keys.js";

type OrderItemReceived = { orgId: string } & Record<(typeof ORDER_ITEM_RECEIVED_KEYS)[number], unknown>;

/** Receive every line of an order not yet received: stamp it, then tell the
 *  wires (stock bump, spend metrics). Returns how many lines were received
 *  now; lines received before are not counted again.
 *
 *  `addToStock` defaults to the order's own add_to_stock. Off, the lines are
 *  still received and still told (the spend is real), with a stock change of
 *  0, so a past purchase being logged never moves the shelf. */
export async function receiveOrderLines(db: Kysely<PurchasesDB>, orgId: string, orderId: string, receivedOn: string, addToStock?: boolean): Promise<number> {
  const adds = addToStock ?? (await orderAddsStock(db, orderId));
  const rows = await sql<{ id: string; part_id: string | null; qty: string | null; unit_cost: string | null; line_amount: string | null; description: string | null }>`
    update purchases_order_items
       set received_at = ${receivedOn}
     where order_id = ${orderId}
       and received_at is null
    returning id, part_id, qty, unit_cost, line_amount, description`.execute(db);
  let received = 0;
  for (const it of rows.rows) {
    received++;
    // A line for no part has no stock to add; it is still received (dated),
    // which is what the price history and "is it still coming?" read.
    if (it.part_id) await tellReceived(orgId, orderId, it as ReceivedLine, adds);
  }
  return received;
}

async function orderAddsStock(db: Kysely<PurchasesDB>, orderId: string): Promise<boolean> {
  const o = await db.selectFrom("purchases_orders").select("add_to_stock").where("id", "=", orderId).executeTakeFirst();
  return o?.add_to_stock !== false;
}

/** A line added to an order that has already arrived arrived with it: receive
 *  it now (its stock, when it names a part; a receipt's unclaimed line is only
 *  dated). Every door that adds a line calls this after the line is claimed,
 *  so no line on an arrived order is ever left unreceived. */
export async function receiveIfArrived(db: Kysely<PurchasesDB>, orgId: string, orderId: string, addToStock?: boolean): Promise<number> {
  const order = await db.selectFrom("purchases_orders").select(["status", "arrived_at", "add_to_stock"]).where("id", "=", orderId).executeTakeFirst();
  if (order?.status !== "arrived") return 0;
  const at = order.arrived_at as Date | string | null;
  const on = at instanceof Date ? at.toISOString().slice(0, 10) : at ? String(at).slice(0, 10) : arrivedEverywhere(new Date());
  return receiveOrderLines(db, orgId, orderId, on, addToStock ?? order.add_to_stock !== false);
}

type ReceivedLine = { id: string; part_id: string; qty: string | null; unit_cost: string | null; line_amount: string | null; description: string | null };

async function tellReceived(orgId: string, orderId: string, it: ReceivedLine, addsStock = true): Promise<void> {
  const qty = Number(it.qty ?? 0);
  const unitCost = it.unit_cost == null ? null : Number(it.unit_cost);
  // The receipt's own line total wins over qty × unit price (0007).
  const lineCost = it.line_amount != null ? Number(it.line_amount) : unitCost == null ? null : Number((unitCost * qty).toFixed(2));
  const payload: OrderItemReceived = {
    orgId,
    orderId,
    orderItemId: it.id,
    partId: it.part_id,
    // The stock change this receipt makes, which the stock wire reads.
    delta: addsStock ? qty : 0,
    qty,
    unitCost,
    lineCost,
    reason: `Order arrived (${it.description ?? "item"})`,
    description: it.description,
  };
  await platform().events.emit("purchases.order_item.received", payload);
}

/** A person settles one line whose stock may never have been added: "add"
 *  tells the stock wire now, "counted" only clears the question. The flag is
 *  cleared in the statement that reads the line, so a double press, or two
 *  people at once, adds it once. Answers whether this call settled it. */
export async function settleUnconfirmedLine(db: Kysely<PurchasesDB>, orgId: string, lineId: string, decision: "add" | "counted"): Promise<boolean> {
  const rows = await sql<ReceivedLine & { order_id: string }>`
    update purchases_order_items
       set receipt_unconfirmed = false
     where id = ${lineId}
       and receipt_unconfirmed
    returning id, order_id, part_id, qty, unit_cost, line_amount, description`.execute(db);
  const it = rows.rows[0];
  if (!it) return false;
  if (decision === "add" && it.part_id) await tellReceived(orgId, it.order_id, it);
  return true;
}
