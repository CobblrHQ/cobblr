// Record a payment (sales:record-payment): the handler its manifest entry names. Wired in ./index.ts.
// The same record as POST /orders/:id/payments, through payments.ts; its Undo is sales:undo-payment.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { recordPayment } from "../payments.js";

export function registerRecordPaymentAction(): void {
  platform().actions.registerHandler("sales.record-payment", async (ctx) => {
    const order = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await recordPayment(db, ctx.orgId, ctx.userId, order.id, { amount: Number(a.amount), method: typeof a.method === "string" ? a.method : null, paid_on: typeof a.paid_on === "string" ? a.paid_on : null }, await platform().money.currency(ctx.orgId), await platform().accounts.dayFor(ctx.userId));
    return r.ok ? { ok: true, payment_id: r.payment_id, owed: r.money.owed, state: r.money.state } : { ok: false, error: r.message, code: r.code };
  });
  platform().actions.registerUndo("sales.record-payment", (result, ctx) => {
    const r = result as { ok?: unknown; payment_id?: unknown } | null;
    if (r?.ok !== true || typeof r.payment_id !== "string" || !ctx.entity) return null;
    return { action_id: "sales:undo-payment", args: { payment_id: r.payment_id }, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  });
}
