// A customer sends something back, and money goes back with it (#8790).
//
// A sale used to have only one way back: cancel the whole order. A shop that
// took a mug back had to cancel the entire sale, which kept it marked Paid with
// its paid day and its total and no record of the refund, so the books said
// money was kept on an order that no longer existed. A return puts goods back
// on the shelf, line by line, and a refund is an amount recorded on the order;
// either may stand alone. Nothing here moves real money: it records what was
// refunded, as purchases' returns do.
//
// The rules, read by every door (the page, the route, the assistant):
//   - only what was fulfilled can come back, and only once;
//   - a refund is never more than was paid: nothing on an unpaid order, and
//     never above what is left after earlier refunds;
//   - a paid order that is cancelled, or has goods back, owes a refund until
//     one is recorded ("refund due");
//   - Undo is exact or says no: it takes the stock out again only if all of it
//     is still on the shelf.

import type { Kysely } from "kysely";
import { fieldCurrency, roundMoneyAmount } from "@cobblr/platform-contract/money";
import type { SalesDB } from "./db.js";
import { withOrderLock } from "./order-lock.js";
import { orderHappened } from "./history.js";
import { adjust } from "./cancel.js";
import { orderTotal } from "./invoice.js";

export interface MoneyLine {
  qty: string | number;
  unit_price: string | number | null;
  qty_returned?: string | number;
  metadata?: Record<string, unknown>;
}

export interface OrderMoney {
  currency: string;
  /** What the lines add up to, before any return. */
  gross: number;
  /** The price of the goods that came back. */
  returned_value: number;
  /** Refunds recorded so far. */
  refunded: number;
  /** What the payments recorded add up to (#8838). */
  paid_amount: number;
  /** What was received and is still kept: what was paid less what was refunded; 0 when unpaid. */
  kept: number;
  /** Refund owed to the customer and not yet recorded; 0 when nothing is due. */
  refund_due: number;
  /** What the sale stands at: the lines less what came back; 0 once cancelled. */
  net_total: number;
  /** What is still to be paid: the net total less what is kept. */
  owed: number;
  /** Paid in full, part paid, or nothing paid. */
  state: "paid" | "part" | "unpaid";
}

const sum = (xs: readonly number[], currency: string) => roundMoneyAmount(xs.reduce((n, x) => n + x, 0), currency);

/** The one answer to "how much?" for an order: the page, the list, the export and the summary all read it.
 *  `payments` are the amounts recorded on the order (#8838); an older caller that has none reads a paid
 *  order as paid in full. */
export function orderMoney(order: { status: string; paid: boolean; metadata?: Record<string, unknown> }, lines: readonly MoneyLine[], refunds: readonly number[], shopCurrency: string, payments?: readonly number[]): OrderMoney {
  const currency = fieldCurrency(order.metadata, "total", shopCurrency);
  const gross = orderTotal(lines, currency).amount;
  const returned_value = sum(
    lines.map((l) => {
      const price = l.unit_price === null ? null : Number(l.unit_price);
      const back = Number(l.qty_returned ?? 0);
      return price === null || !Number.isFinite(price) || !(back > 0) ? 0 : roundMoneyAmount(back * price, currency);
    }),
    currency,
  );
  const refunded = sum(refunds, currency);
  const paid_amount = payments ? sum(payments, currency) : order.paid ? gross : 0;
  const cancelled = order.status === "cancelled";
  const net_total = cancelled ? 0 : roundMoneyAmount(Math.max(0, gross - returned_value), currency);
  const kept = roundMoneyAmount(Math.max(0, paid_amount - refunded), currency);
  const refund_due = roundMoneyAmount(Math.max(0, paid_amount - refunded - net_total), currency);
  const owed = cancelled ? 0 : roundMoneyAmount(Math.max(0, net_total - kept), currency);
  const state = paid_amount > 0 ? (owed > 0 ? "part" : "paid") : order.paid && !cancelled && net_total === 0 ? "paid" : "unpaid";
  return { currency, gross, returned_value, refunded, paid_amount, kept, refund_due, net_total, owed, state };
}

export type ReturnInput = { line_id?: string | null; qty?: number | null; refund_amount?: number | null; reason?: string | null };

export type ReturnResult =
  | { ok: true; return_id: string; restocked: number; refunded: number; refund_due: number }
  | { ok: false; code: "not_found" | "nothing_to_record" | "no_such_line" | "too_many" | "nothing_paid" | "too_much_refund"; message: string };

export type UndoReturnResult = { ok: true } | { ok: false; code: "not_found" | "not_on_shelf"; message: string };

async function read(db: Kysely<SalesDB>, orderId: string) {
  const order = await db.selectFrom("sales_orders").select(["id", "status", "paid", "metadata"]).where("id", "=", orderId).executeTakeFirst();
  if (!order) return null;
  const lines = await db.selectFrom("sales_order_items").select(["id", "part_id", "qty", "qty_fulfilled", "qty_returned", "unit_price", "metadata"]).where("order_id", "=", orderId).execute();
  const returns = await db.selectFrom("sales_returns").select(["id", "line_id", "qty", "restocked", "refund_amount"]).where("order_id", "=", orderId).execute();
  const payments = await db.selectFrom("sales_payments").select(["amount"]).where("order_id", "=", orderId).execute();
  return { order, lines, returns, payments: payments.map((p) => Number(p.amount)) };
}

/** Record goods coming back and/or a refund. */
export async function recordReturn(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, input: ReturnInput, shopCurrency: string): Promise<ReturnResult> {
  return withOrderLock(db, orgId, userId, orderId, async () => {
    const got = await read(db, orderId);
    if (!got) return { ok: false, code: "not_found", message: "That order is not here any more." };
    const qty = input.qty ?? null;
    const refund = input.refund_amount ?? null;
    if (!(qty && qty > 0) && !(refund !== null && refund > 0)) return { ok: false, code: "nothing_to_record", message: "Say what came back or how much was refunded." };

    let line: (typeof got.lines)[number] | undefined;
    let restocked = 0;
    if (qty && qty > 0) {
      line = got.lines.find((l) => l.id === input.line_id);
      if (!line) return { ok: false, code: "no_such_line", message: "Choose the line it came from." };
      const room = (Number(line.qty_fulfilled) || 0) - (Number(line.qty_returned) || 0);
      if (qty > room) return { ok: false, code: "too_many", message: room > 0 ? `Only ${room} of this line can still come back.` : "Nothing on this line is left to come back: it is not fulfilled, or all of it has already come back." };
    }

    const before = orderMoney(got.order, got.lines, got.returns.map((r) => Number(r.refund_amount ?? 0)), shopCurrency, got.payments);
    if (refund !== null && refund > 0) {
      if (!(before.paid_amount > 0)) return { ok: false, code: "nothing_paid", message: "Nothing has been paid on this order, so there is nothing to refund." };
      const left = roundMoneyAmount(before.paid_amount - before.refunded, before.currency);
      if (refund > left + 1e-9) return { ok: false, code: "too_much_refund", message: left > 0 ? `A refund can't be more than was paid: ${left} is left to refund.` : "The whole amount paid has already been refunded." };
    }

    if (qty && qty > 0 && line) {
      if (line.part_id) restocked = await adjust(orgId, userId, orderId, line.part_id, qty, "sale-returned");
      await db.updateTable("sales_order_items").set({ qty_returned: String((Number(line.qty_returned) || 0) + qty), updated_at: new Date() }).where("id", "=", line.id).execute();
    }
    const row = await db
      .insertInto("sales_returns")
      .values({ order_id: orderId, line_id: line?.id ?? null, qty: qty ?? null, restocked, refund_amount: refund !== null && refund > 0 ? refund : null, reason: input.reason?.trim() || null, created_by: userId })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const after = await read(db, orderId);
    const money = orderMoney(got.order, after!.lines, after!.returns.map((r) => Number(r.refund_amount ?? 0)), shopCurrency, after!.payments);
    await orderHappened(db, orgId, orderId, { kind: "return", detail: { return_id: row.id, line_id: line?.id ?? null, qty: qty ?? null, restocked, refund: refund ?? null, reason: input.reason?.trim() || null }, by_user: userId });
    return { ok: true, return_id: row.id, restocked, refunded: money.refunded, refund_due: money.refund_due };
  });
}

/** Take a recorded return back, exactly or not at all. */
export async function undoReturn(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, returnId: string): Promise<UndoReturnResult> {
  return withOrderLock(db, orgId, userId, orderId, async () => {
    const r = await db.selectFrom("sales_returns").selectAll().where("id", "=", returnId).where("order_id", "=", orderId).executeTakeFirst();
    if (!r) return { ok: false, code: "not_found", message: "That return is not here any more." };
    const line = r.line_id ? await db.selectFrom("sales_order_items").select(["id", "part_id", "qty_returned"]).where("id", "=", r.line_id).executeTakeFirst() : undefined;
    const put = Number(r.restocked) || 0;
    if (put > 0 && line?.part_id) {
      const took = await adjust(orgId, userId, orderId, line.part_id, -put, "sale-return-undone");
      if (took < put) {
        // A part of it came out: give it back, so a refusal changes nothing.
        if (took > 0) await adjust(orgId, userId, orderId, line.part_id, took, "sale-return-undone");
        return { ok: false, code: "not_on_shelf", message: `Only ${took} of the ${put} that went back on the shelf are still there, so this can't be undone. Nothing was changed.` };
      }
    }
    if (line && r.qty) await db.updateTable("sales_order_items").set({ qty_returned: String(Math.max(0, (Number(line.qty_returned) || 0) - Number(r.qty))), updated_at: new Date() }).where("id", "=", line.id).execute();
    await db.deleteFrom("sales_returns").where("id", "=", returnId).execute();
    await orderHappened(db, orgId, orderId, { kind: "return", detail: { return_id: returnId, undone: true, qty: r.qty === null ? null : Number(r.qty), refund: r.refund_amount === null ? null : Number(r.refund_amount) }, by_user: userId });
    return { ok: true };
  });
}

/** Every order's money, for a page of orders, from one read of their lines and refunds. */
export async function moneyOfOrders(
  db: Kysely<SalesDB>,
  orders: ReadonlyArray<{ id: string; status: string; paid: boolean; metadata: Record<string, unknown> }>,
  shopCurrency: string,
): Promise<Map<string, OrderMoney>> {
  const out = new Map<string, OrderMoney>();
  if (!orders.length) return out;
  const ids = orders.map((o) => o.id);
  const lines = await db.selectFrom("sales_order_items").select(["order_id", "qty", "unit_price", "qty_returned", "metadata"]).where("order_id", "in", ids).execute();
  const refunds = await db.selectFrom("sales_returns").select(["order_id", "refund_amount"]).where("order_id", "in", ids).where("refund_amount", "is not", null).execute();
  const payments = await db.selectFrom("sales_payments").select(["order_id", "amount"]).where("order_id", "in", ids).execute();
  for (const o of orders) out.set(o.id, orderMoney(o, lines.filter((l) => l.order_id === o.id), refunds.filter((r) => r.order_id === o.id).map((r) => Number(r.refund_amount)), shopCurrency, payments.filter((p) => p.order_id === o.id).map((p) => Number(p.amount))));
  return out;
}
