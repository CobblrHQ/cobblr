// A month of sales, said once (#8786, #8787). A shop closing the month asks
// what was sold, what is paid, what is still owed and what is owed back, and an
// accountant wants the same figures per order. Both come from orderMoney, the
// one answer the order page uses, so the summary, the file and the order agree:
//
//   sold  =  received - refund due + owed        (always, per currency)
//
// Cancelled orders stand at nothing; a paid one that was cancelled shows in
// "received" and in "refund due" until a refund is recorded.

import { toCsv } from "@cobblr/platform-contract/csv";
import { addMoney, roundMoneyAmount } from "@cobblr/platform-contract/money";
import type { OrderMoney } from "./returns.js";

export interface SummaryOrder {
  status: string;
  paid: boolean;
  money: OrderMoney;
}

export interface MoneySummary {
  currency: string;
  /** Orders counted (cancelled ones are listed apart). */
  orders: number;
  cancelled: number;
  sold: number;
  received: number;
  refunded: number;
  refund_due: number;
  owed: number;
}

/** One summary per currency: amounts in different currencies are never added together. */
export function summarise(orders: readonly SummaryOrder[]): MoneySummary[] {
  const by = new Map<string, MoneySummary>();
  for (const o of orders) {
    const c = o.money.currency;
    const s = by.get(c) ?? { currency: c, orders: 0, cancelled: 0, sold: 0, received: 0, refunded: 0, refund_due: 0, owed: 0 };
    if (o.status === "cancelled") s.cancelled++;
    else s.orders++;
    s.sold = addMoney(s.sold, o.money.net_total, c);
    s.received = addMoney(s.received, o.money.kept, c);
    s.refunded = addMoney(s.refunded, o.money.refunded, c);
    s.refund_due = addMoney(s.refund_due, o.money.refund_due, c);
    s.owed = addMoney(s.owed, o.money.owed, c);
    by.set(c, s);
  }
  return [...by.values()].map((s) => ({
    ...s,
    sold: roundMoneyAmount(s.sold, s.currency),
    received: roundMoneyAmount(s.received, s.currency),
    refunded: roundMoneyAmount(s.refunded, s.currency),
    refund_due: roundMoneyAmount(s.refund_due, s.currency),
    owed: roundMoneyAmount(s.owed, s.currency),
  }));
}

export interface AccountingOrder extends SummaryOrder {
  order_number: string | null;
  order_date: string | null;
  customer_name: string | null;
  /** The day of the last payment, or null. */
  paid_on: string | null;
}

/** A file that would carry a figure nothing can add up. The route answers with its sentence. */
export class MoneyFileRefused extends Error {}

/** The accountant's file: one row per order, every amount the same figure the order's page shows.
 *  Refused while an order has a line nothing can add up, as its figures would leave that line out. */
export function accountingCsv(orders: readonly AccountingOrder[]): string {
  const wrong = orders.filter((o) => {
    const m = o.money;
    return (o.status !== "cancelled" && m.impossible_lines > 0) || ![m.gross, m.returned_value, m.refunded, m.net_total, m.kept, m.refund_due, m.owed].every(Number.isFinite);
  });
  if (wrong.length) {
    const named = wrong.slice(0, 5).map((o) => o.order_number ?? "an order with no number").join(", ");
    throw new MoneyFileRefused(`Check the quantities and prices before exporting: ${named}${wrong.length > 5 ? ` and ${wrong.length - 5} more` : ""}.`);
  }
  return toCsv(
    ["Order", "Order date", "Customer", "Status", "Payment status", "Paid on", "Currency", "Order total", "Returned goods", "Refunded", "Net total", "Received", "Refund due", "Owed"],
    orders.map((o) => [
      o.order_number ?? "",
      o.order_date?.slice(0, 10) ?? "",
      o.customer_name ?? "",
      o.status,
      o.money.state === "paid" ? "Paid" : o.money.state === "part" ? "Part paid" : "Not marked paid",
      o.paid_on ?? "",
      o.money.currency,
      o.money.gross,
      o.money.returned_value,
      o.money.refunded,
      o.money.net_total,
      o.money.kept,
      o.money.refund_due,
      o.money.owed,
    ]),
  );
}
