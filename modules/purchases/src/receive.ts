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
import { amountOf, centsFromAmount } from "@cobblr/platform-contract/money";

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
    returning id, part_id, qty, unit_cost, line_amount, description, stock_withdrawn_at`.execute(db);
  let received = 0;
  for (const it of rows.rows) {
    received++;
    // A line for no part has no stock to add; it is still received (dated),
    // which is what the price history and "is it still coming?" read.
    if (it.part_id) await tellReceived(orgId, orderId, it as ReceivedLine, adds);
  }
  return received;
}

/** Receive ONE line, claiming it for `partId` when it names none: the same
 *  stamp-then-tell as a whole order, so a line received by scan is never
 *  received again when the order later arrives. Answers whether this call
 *  received it. */
export async function receiveOrderLine(db: Kysely<PurchasesDB>, orgId: string, lineId: string, receivedOn: string, partId: string | null): Promise<boolean> {
  const rows = await sql<ReceivedLine & { order_id: string; part_id: string | null }>`
    update purchases_order_items
       set received_at = ${receivedOn}, part_id = coalesce(part_id, ${partId}::uuid)
     where id = ${lineId}
       and received_at is null
    returning id, order_id, part_id, qty, unit_cost, line_amount, description, stock_withdrawn_at`.execute(db);
  const it = rows.rows[0];
  if (!it) return false;
  if (it.part_id) await tellReceived(orgId, it.order_id, it as ReceivedLine, await orderAddsStock(db, it.order_id));
  return true;
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

type ReceivedLine = { id: string; part_id: string; qty: string | null; unit_cost: string | null; line_amount: string | null; description: string | null; stock_withdrawn_at?: Date | string | null };

async function tellReceived(orgId: string, orderId: string, it: ReceivedLine, addsStock = true): Promise<void> {
  const qty = Number(it.qty ?? 0);
  const unitCost = it.unit_cost == null ? null : Number(it.unit_cost);
  // The receipt's own line total wins over qty × unit price (0007).
  const lineCost = it.line_amount != null ? Number(it.line_amount) : unitCost == null ? null : amountOf(centsFromAmount(unitCost * qty));
  // Received once already and taken back (unreceiveOrderLines): its spend was
  // told the first time, so this receive moves the shelf and nothing else.
  const counted = !!it.stock_withdrawn_at;
  const payload: OrderItemReceived = {
    orgId,
    orderId,
    orderItemId: it.id,
    partId: it.part_id,
    // The stock change this receipt makes, which the stock wire reads.
    delta: addsStock ? qty : 0,
    qty,
    unitCost: counted ? null : unitCost,
    lineCost: counted ? null : lineCost,
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

/** Take back the receive of every line of an order that was received with
 *  it: the receipt filed the order as arrived (no tracking number, no
 *  promised day), and a shipping notice since proved it was still on its way.
 *  The stamp is cleared in the statement that reads it, so a second notice
 *  takes nothing back twice; a part's stock leaves the shelf once (delta < 0),
 *  and stock_withdrawn_at keeps its cost from being counted again when it
 *  really arrives. Answers how many lines were taken back. */
export async function unreceiveOrderLines(db: Kysely<PurchasesDB>, orgId: string, orderId: string, reason: string): Promise<number> {
  const adds = await orderAddsStock(db, orderId);
  const rows = await sql<ReceivedLine & { part_id: string | null }>`
    update purchases_order_items
       set received_at = null, stock_withdrawn_at = now()
     where order_id = ${orderId}
       and received_at is not null
    returning id, part_id, qty, unit_cost, line_amount, description`.execute(db);
  for (const it of rows.rows) {
    if (!it.part_id || !adds) continue;
    const qty = Number(it.qty ?? 0);
    const payload: OrderItemReceived = {
      orgId,
      orderId,
      orderItemId: it.id,
      partId: it.part_id,
      delta: -qty,
      qty,
      unitCost: null,
      lineCost: null,
      reason: `${reason} (${it.description ?? "item"})`,
      description: it.description,
    };
    await platform().events.emit("purchases.order_item.unreceived", payload);
  }
  return rows.rows.length;
}

/** How many of a line's units are in hand, counted one by one (#5734): a
 *  scan of each spool of ten. The tenth receives the line, through the one
 *  receive above, so it is received exactly once. A count that drops below
 *  full again takes the receive back only when the count made it and it
 *  added no stock (no thing claimed the line yet); otherwise the receive
 *  stands and the count says what is in hand. */
export async function setReceivedCount(db: Kysely<PurchasesDB>, orgId: string, lineId: string, received: number, receivedOn: string): Promise<{ received: number; qty: number; receivedAt: string | null } | null> {
  const line = await db.selectFrom("purchases_order_items").select(["id", "qty", "part_id", "received_at", "metadata"]).where("id", "=", lineId).executeTakeFirst();
  if (!line) return null;
  const qty = Math.max(0, Number(line.qty ?? 0));
  const count = Math.max(0, Math.min(Math.round(received), qty));
  await db.updateTable("purchases_order_items").set({ received_qty: count, updated_at: new Date() } as never).where("id", "=", lineId).execute();
  const byCount = (line.metadata as { received_by_count?: unknown } | null)?.received_by_count === true;
  if (count >= qty && qty > 0 && !line.received_at) {
    if (await receiveOrderLine(db, orgId, lineId, receivedOn, null)) {
      await sql`update purchases_order_items set metadata = coalesce(metadata, '{}'::jsonb) || '{"received_by_count": true}'::jsonb where id = ${lineId}`.execute(db);
    }
  } else if (count < qty && line.received_at && byCount && !line.part_id) {
    await sql`update purchases_order_items set received_at = null, metadata = coalesce(metadata, '{}'::jsonb) - 'received_by_count' where id = ${lineId} and part_id is null`.execute(db);
  }
  const after = await db.selectFrom("purchases_order_items").select(["received_at"]).where("id", "=", lineId).executeTakeFirst();
  return { received: count, qty, receivedAt: after?.received_at ? new Date(after.received_at as unknown as string).toISOString() : null };
}
