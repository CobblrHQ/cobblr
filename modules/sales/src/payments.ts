// What a customer paid on an order (#8838).
//
// An order's payments are a list, each with an amount, a method and a day.
// Paid, part paid and owed are read from that list less the refunds
// (orderMoney), never from a yes/no. Several payments on one order are a part
// payment or a split between cash and card. Nothing here moves real money: it
// records what was received, as the refunds record what was given back.
//
// The rules, read by every door (the page, the route, the assistant):
//   - a payment is more than nothing and never more than is still owed;
//   - nothing is paid on a cancelled order;
//   - Undo of a payment is refused when a refund was recorded that it paid for.
// The orders.paid column stays as a cache, set from the payments after every
// change, for the readers that filter on it.

import type { Kysely } from "kysely";
import { isRealDay } from "@cobblr/platform-contract/day";
import { roundMoneyAmount } from "@cobblr/platform-contract/money";
import type { SalesDB } from "./db.js";
import { withOrderLock } from "./order-lock.js";
import { orderHappened } from "./history.js";
import { moneyOfOrders, type OrderMoney } from "./returns.js";

export type PaymentInput = { amount: number; method?: string | null; paid_on?: string | null };

export type PaymentResult =
  | { ok: true; payment_id: string; money: OrderMoney }
  | { ok: false; code: "not_found" | "cancelled" | "not_an_amount" | "not_a_day" | "too_much"; message: string };

export type UndoPaymentResult = { ok: true; money: OrderMoney } | { ok: false; code: "not_found" | "refunded"; message: string };

async function moneyOf(db: Kysely<SalesDB>, orderId: string, shopCurrency: string): Promise<OrderMoney | null> {
  const order = await db.selectFrom("sales_orders").select(["id", "status", "paid", "metadata"]).where("id", "=", orderId).executeTakeFirst();
  if (!order) return null;
  return (await moneyOfOrders(db, [order as never], shopCurrency)).get(orderId) ?? null;
}

/** Set the paid cache from the payments, so the older readers agree with them. */
export async function syncPaid(db: Kysely<SalesDB>, orderId: string, shopCurrency: string): Promise<OrderMoney | null> {
  const money = await moneyOf(db, orderId, shopCurrency);
  if (!money) return null;
  await db.updateTable("sales_orders").set({ paid: money.state === "paid" } as never).where("id", "=", orderId).where("paid", "!=", money.state === "paid").execute();
  return money;
}

/** Record a payment on an order. */
export async function recordPayment(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, input: PaymentInput, shopCurrency: string, today: string): Promise<PaymentResult> {
  return withOrderLock(db, orgId, userId, orderId, async () => {
    const before = await moneyOf(db, orderId, shopCurrency);
    if (!before) return { ok: false, code: "not_found", message: "That order is not here any more." };
    const order = await db.selectFrom("sales_orders").select(["status"]).where("id", "=", orderId).executeTakeFirstOrThrow();
    if (order.status === "cancelled") return { ok: false, code: "cancelled", message: "This order is cancelled, so nothing can be paid on it." };
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || !(amount > 0)) return { ok: false, code: "not_an_amount", message: "Say how much was paid." };
    if (amount > before.owed + 1e-9) return { ok: false, code: "too_much", message: before.owed > 0 ? `That is more than is owed: ${before.owed} is still to pay.` : "Nothing is owed on this order." };
    const paid_on = input.paid_on?.trim() || today;
    if (!isRealDay(paid_on)) return { ok: false, code: "not_a_day", message: "That is not a day on the calendar." };
    const method = input.method?.trim().slice(0, 40) || "other";
    const row = await db
      .insertInto("sales_payments")
      .values({ order_id: orderId, amount: roundMoneyAmount(amount, before.currency), method, paid_on, created_by: userId })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const money = (await syncPaid(db, orderId, shopCurrency))!;
    await orderHappened(db, orgId, orderId, { kind: "payment", detail: { payment_id: row.id, amount, method, paid_on, owed: money.owed }, by_user: userId });
    return { ok: true, payment_id: row.id, money };
  });
}

/** Take a recorded payment back. */
export async function undoPayment(db: Kysely<SalesDB>, orgId: string, userId: string | null, orderId: string, paymentId: string, shopCurrency: string): Promise<UndoPaymentResult> {
  return withOrderLock(db, orgId, userId, orderId, async () => {
    const p = await db.selectFrom("sales_payments").selectAll().where("id", "=", paymentId).where("order_id", "=", orderId).executeTakeFirst();
    if (!p) return { ok: false, code: "not_found", message: "That payment is not here any more." };
    const before = await moneyOf(db, orderId, shopCurrency);
    if (before && before.paid_amount - Number(p.amount) + 1e-9 < before.refunded) {
      return { ok: false, code: "refunded", message: "A refund was recorded against what was paid, so this payment can't be taken back. Nothing was changed." };
    }
    await db.deleteFrom("sales_payments").where("id", "=", paymentId).execute();
    const money = (await syncPaid(db, orderId, shopCurrency))!;
    await orderHappened(db, orgId, orderId, { kind: "payment", detail: { payment_id: paymentId, undone: true, amount: Number(p.amount), method: p.method, paid_on: p.paid_on }, by_user: userId });
    return { ok: true, money };
  });
}
