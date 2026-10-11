import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { roundMoneyAmount, fieldCurrency, readMoney, type MoneyTotal } from "@cobblr/platform-contract/money";
import { fieldDay } from "@cobblr/platform-contract/field-day";
import type { PurchasesDB } from "./db.js";

type Order = { id: string; metadata: unknown; ordered_at: unknown; created_at: unknown; total_cost: unknown; shipping_cost: unknown };
export async function orderFigures<T extends Order>(orgId: string, db: Kysely<PurchasesDB>, orders: T[]) {
  const main = await platform().money.currency(orgId);
  const lines = orders.length ? await db.selectFrom("purchases_order_items").select(["order_id", "qty", "unit_cost", "line_amount", "metadata"])
    .where("order_id", "in", orders.map((o) => o.id)).execute() : [];
  // A refund comes off what the order cost (#4250), here as in orderTotal():
  // one amount per refunded return, so a refund told twice comes off once.
  const refunds = orders.length ? await db.selectFrom("purchases_returns").select(["order_id", "refund_amount"])
    .where("order_id", "in", orders.map((o) => o.id)).where("stage", "=", "refunded").where("refund_amount", "is not", null).execute() : [];
  const refundedBy = new Map<string, number>();
  for (const r of refunds) refundedBy.set(r.order_id, (refundedBy.get(r.order_id) || 0) + Number(r.refund_amount));
  const byOrder = new Map<string, typeof lines>();
  for (const l of lines) byOrder.set(l.order_id, [...(byOrder.get(l.order_id) || []), l]);
  const out: Array<T & { currency: string; total: number | null; money_total: MoneyTotal; computed_total: number; refunded: number; unpriced_lines: number }> = [];
  for (const o of orders) {
    const currency = fieldCurrency(o.metadata, "total_cost", main);
    const day = fieldDay(o.ordered_at) || fieldDay(o.created_at) || "";
    const stated = readMoney(o.total_cost, "amount", currency);
    const ownLines = byOrder.get(o.id) || [];
    const unpricedLines = stated ? 0 : ownLines.filter((l) => l.line_amount == null && l.unit_cost == null).length;
    const lineEntries = ownLines.flatMap((l) => {
      const amount = l.line_amount != null ? Number(l.line_amount) : l.unit_cost != null ? Number(l.qty) * Number(l.unit_cost) : null;
      return amount === null ? [] : [{ value: { amount, currency: fieldCurrency(l.metadata, "unit_cost", currency) }, day }];
    });
    {
      const shipping = readMoney(o.shipping_cost, "amount", fieldCurrency(o.metadata, "shipping_cost", currency));
      if (shipping) lineEntries.push({ value: shipping, day });
    }
    const refunded = refundedBy.get(o.id) || 0;
    const back = refunded ? [{ value: { amount: -refunded, currency }, day }] : [];
    const entries = [...(stated ? [{ value: stated, day }] : lineEntries), ...back];
    const computed = await platform().money.total(orgId, lineEntries, currency);
    const own = stated || refunded ? await platform().money.total(orgId, entries, currency) : computed;
    const sum = currency === main ? own : await platform().money.total(orgId, entries, main);
    out.push({ ...o, currency, total: entries.length > back.length ? own.amount : null, computed_total: computed.amount, money_total: sum, refunded, unpriced_lines: unpricedLines });
  }
  return out;
}
export function combineOrderTotals(totals: MoneyTotal[], currency: string): MoneyTotal {
  const excluded: Record<string, number> = {};
  for (const t of totals) for (const [c, n] of Object.entries(t.excluded)) excluded[c] = (excluded[c] || 0) + n;
  return { currency, amount: roundMoneyAmount(totals.reduce((n, t) => n + t.amount, 0), currency), excluded, conversions: totals.flatMap((t) => t.conversions) };
}
