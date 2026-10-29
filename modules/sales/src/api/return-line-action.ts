// Record a return or refund (sales:return-line): the handler its manifest entry names. Wired in ./index.ts.
// The same record as POST /orders/:id/returns, through returns.ts; its Undo is sales:undo-return.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { recordReturn } from "../returns.js";

export function registerReturnLineAction(): void {
  platform().actions.registerHandler("sales.return-line", async (ctx) => {
    const order = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await recordReturn(db, ctx.orgId, ctx.userId, order.id, { line_id: typeof a.line_id === "string" ? a.line_id : null, qty: num(a.qty), refund_amount: num(a.refund_amount), reason: typeof a.reason === "string" ? a.reason : null }, await platform().money.currency(ctx.orgId));
    return r.ok ? { ok: true, return_id: r.return_id, restocked: r.restocked, refunded: r.refunded, refund_due: r.refund_due } : { ok: false, error: r.message, code: r.code };
  });
  platform().actions.registerUndo("sales.return-line", (result, ctx) => {
    const r = result as { ok?: unknown; return_id?: unknown } | null;
    if (r?.ok !== true || typeof r.return_id !== "string" || !ctx.entity) return null;
    return { action_id: "sales:undo-return", args: { return_id: r.return_id }, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  });
}
