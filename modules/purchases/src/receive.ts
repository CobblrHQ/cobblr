import { ReceiptPending } from "./receipt-pending.js";
import { sql, type Kysely } from "kysely";
import { arrivedEverywhere, platform } from "@cobblr/platform-contract";
import type { PurchasesDB } from "./db.js";

import { ORDER_ITEM_RECEIVED_KEYS } from "./receive-keys.js";
import { amountOf, centsFromAmount } from "@cobblr/platform-contract/money";

type OrderItemReceived = { orgId: string } & Record<(typeof ORDER_ITEM_RECEIVED_KEYS)[number], unknown>;

/** Stamp each new receipt and its outbox entry together, then deliver the
 *  stock and spend events. A retry also drains previously claimed entries.
 *  Returns how many new lines were received.
 *
 *  `addToStock` defaults to the order's own add_to_stock. Off, the lines are
 *  still received and still told (the spend is real), with a stock change of
 *  0, so a past purchase being logged never moves the shelf. */
export async function receiveOrderLines(db: Kysely<PurchasesDB>, orgId: string, orderId: string, receivedOn: string, addToStock?: boolean): Promise<number> {
  const adds = addToStock ?? (await orderAddsStock(db, orderId));
  const received = await db.transaction().execute(async trx => {
    const rows = await sql<ReceivedLine>`
      update purchases_order_items set received_at = ${receivedOn}
       where order_id = ${orderId} and received_at is null
       returning id, part_id, qty, unit_cost, line_amount, description, stock_withdrawn_at`.execute(trx);
    for (const it of rows.rows) {
      if (it.part_id) await queueReceived(trx, orgId, orderId, it, adds);
    }
    return rows.rows.length;
  });
  await flushReceipts(db, orgId, { orderId });
  return received;
}

export async function receiveOrderLine(db: Kysely<PurchasesDB>, orgId: string, lineId: string, receivedOn: string, partId: string | null): Promise<boolean> {
  const received = await db.transaction().execute(async trx => {
    const rows = await sql<ReceivedLine & { order_id: string }>`
      update purchases_order_items
         set received_at = ${receivedOn}, part_id = coalesce(part_id, ${partId}::uuid)
       where id = ${lineId} and received_at is null
       returning id, order_id, part_id, qty, unit_cost, line_amount, description, stock_withdrawn_at`.execute(trx);
    const it = rows.rows[0];
    if (!it) return false;
    if (it.part_id) await queueReceived(trx, orgId, it.order_id, it, await orderAddsStock(trx, it.order_id));
    return true;
  });
  await flushReceipts(db, orgId, { lineId });
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

type ReceivedLine = { id: string; part_id: string; qty: string | null; unit_cost: string | null; line_amount: string | null; description: string | null; stock_withdrawn_at?: Date | string | null };

async function queueReceived(db: Kysely<PurchasesDB>, orgId: string, orderId: string, it: ReceivedLine, addsStock = true): Promise<void> {
  const operationId = crypto.randomUUID();
  const qty = Number(it.qty ?? 0);
  const unitCost = it.unit_cost == null ? null : Number(it.unit_cost);
  // The receipt's own line total wins over qty × unit price (0007).
  const lineCost = it.line_amount != null ? Number(it.line_amount) : unitCost == null ? null : amountOf(centsFromAmount(unitCost * qty));
  // Received once already and taken back (unreceiveOrderLines): its spend was
  // told the first time, so this receive moves the shelf and nothing else.
  const counted = !!it.stock_withdrawn_at;
  const payload: OrderItemReceived = {
    orgId,
    operationId,
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
  await db.insertInto("purchases_receive_outbox").values({
    id: operationId, order_id: orderId, line_id: it.id, payload,
    completed_at: null, last_error: null,
  }).execute();
}

/** A person settles one line whose stock may never have been added: "add"
 *  tells the stock wire now, "counted" only clears the question. The flag is
 *  cleared in the statement that reads the line, so a double press, or two
 *  people at once, adds it once. Answers whether this call settled it. */
export async function settleUnconfirmedLine(db: Kysely<PurchasesDB>, orgId: string, lineId: string, decision: "add" | "counted"): Promise<boolean> {
  const settled = await db.transaction().execute(async trx => {
    const rows = await sql<ReceivedLine & { order_id: string }>`
      update purchases_order_items set receipt_unconfirmed = false
       where id = ${lineId} and receipt_unconfirmed
       returning id, order_id, part_id, qty, unit_cost, line_amount, description`.execute(trx);
    const it = rows.rows[0];
    if (!it) return false;
    if (decision === "add" && it.part_id) await queueReceived(trx, orgId, it.order_id, it);
    return true;
  });
  await flushReceipts(db, orgId, { lineId });
  return settled;
}

/** Take back the receive of every line of an order that was received with
 *  it: the receipt filed the order as arrived (no tracking number, no
 *  promised day), and a shipping notice since proved it was still on its way.
 *  The stamp is cleared in the statement that reads it, so a second notice
 *  takes nothing back twice; a part's stock leaves the shelf once (delta < 0),
 *  and stock_withdrawn_at keeps its cost from being counted again when it
 *  really arrives. Answers how many lines were taken back. */
export async function unreceiveOrderLines(db: Kysely<PurchasesDB>, orgId: string, orderId: string, reason: string): Promise<number> {
  await flushReceipts(db, orgId, { orderId });
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
      operationId: crypto.randomUUID(),
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
  if (count >= qty && qty > 0) {
    if (await receiveOrderLine(db, orgId, lineId, receivedOn, null)) {
      await sql`update purchases_order_items set metadata = coalesce(metadata, '{}'::jsonb) || '{"received_by_count": true}'::jsonb where id = ${lineId}`.execute(db);
    }
  } else if (count < qty && line.received_at && byCount && !line.part_id) {
    await sql`update purchases_order_items set received_at = null, metadata = coalesce(metadata, '{}'::jsonb) - 'received_by_count' where id = ${lineId} and part_id is null`.execute(db);
  }
  const after = await db.selectFrom("purchases_order_items").select(["received_at"]).where("id", "=", lineId).executeTakeFirst();
  return { received: count, qty, receivedAt: after?.received_at ? new Date(after.received_at as unknown as string).toISOString() : null };
}

export async function flushReceipts(db: Kysely<PurchasesDB>, orgId: string, scope: { orderId?: string; lineId?: string } = {}): Promise<void> {
  let query = db.selectFrom("purchases_receive_outbox").select("id").where("completed_at", "is", null).orderBy("next_attempt_at").orderBy("id");
  if (scope.orderId) query = query.where("order_id", "=", scope.orderId);
  if (scope.lineId) query = query.where("line_id", "=", scope.lineId);
  if (!scope.orderId && !scope.lineId) query = query.where("next_attempt_at", "<=", new Date()).limit(50);
  let failed = false;
  for (const { id } of await query.execute()) {
    let deliveryFailed = false;
    const run = await platform().exclusive.run(`purchases:receipt:${orgId}:${id}`, async () => {
      const row = await db.selectFrom("purchases_receive_outbox").selectAll().where("id", "=", id).where("completed_at", "is", null).executeTakeFirst();
      if (!row) return;
      const completed = [...row.completed_recipients];
      try {
        await platform().events.emit("purchases.order_item.received", { ...row.payload, orgId }, {
          id, completed,
          acknowledge: async key => {
            completed.push(key);
            await db.updateTable("purchases_receive_outbox").set({ completed_recipients: sql`${JSON.stringify(completed)}::jsonb` }).where("id", "=", id).execute();
          },
        });
        await db.updateTable("purchases_receive_outbox").set({ completed_at: new Date(), last_error: null }).where("id", "=", id).execute();
      // pass-catch: save the failure on the receipt, then throw ReceiptPending after the remaining deliveries.
      } catch (err) {
        await db.updateTable("purchases_receive_outbox").set({ last_error: (err as Error).message.slice(0, 1000), next_attempt_at: new Date(Date.now() + 60_000) }).where("id", "=", id).execute();
        deliveryFailed = true;
      }
    });
    failed ||= !run.ran || deliveryFailed;
  }
  if (failed) throw new ReceiptPending();
}

export function registerReceiptRetries(): void {
  platform().sweeps.register({
    name: "purchases.receipt-retries", module: "purchases", everyMs: 60_000,
    visit: async ({ orgId, db }) => { await flushReceipts(db as Kysely<PurchasesDB>, orgId); },
  });
}
