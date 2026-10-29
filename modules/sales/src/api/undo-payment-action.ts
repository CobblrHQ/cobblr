// Take a recorded payment back (sales:undo-payment): the handler its manifest entry names. Wired in ./index.ts.
// Run only from Undo. Refused when a refund was recorded against what it paid.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { undoPayment } from "../payments.js";

export function registerUndoPaymentAction(): void {
  platform().actions.registerHandler("sales.undo-payment", async (ctx) => {
    const order = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await undoPayment(db, ctx.orgId, ctx.userId, order.id, String((ctx.args as { payment_id?: unknown } | null)?.payment_id ?? ""), await platform().money.currency(ctx.orgId));
    return r.ok ? { ok: true } : { ok: false, error: r.message, code: r.code };
  });
}
