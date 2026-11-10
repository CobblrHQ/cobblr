// Hold an order's stock (sales:hold-order): the handler its manifest entry names. Wired in ./index.ts.
// The same record as POST /orders/:id/hold, through holds.ts; its Undo is sales:release-hold.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { holdOrder } from "../holds.js";

export function registerHoldOrderAction(): void {
  platform().actions.registerHandler("sales.hold-order", async (ctx) => {
    const order = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await holdOrder(db, ctx.orgId, ctx.userId, order.id, { until: typeof a.until === "string" ? a.until : null });
    return r.ok ? { ok: true, held: r.held, until: r.until, held_at: r.held_at, previous: r.previous } : { ok: false, error: r.message, code: r.code };
  });
  platform().actions.registerUndo("sales.hold-order", (result, ctx) => {
    const r = result as { ok?: unknown; held_at?: unknown; previous?: unknown } | null;
    if (r?.ok !== true || !ctx.entity) return null;
    // This hold only, while the order still has it (#9421).
    const own = typeof r.held_at === "string" ? { held_at: r.held_at, previous: r.previous ?? null } : {};
    return { action_id: "sales:release-hold", args: own, entity_kind: ctx.entity.kind, entity_id: ctx.entity.id };
  });
}
