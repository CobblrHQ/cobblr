// Take a recorded return back (sales:undo-return): the handler its manifest entry names. Wired in ./index.ts.
// Run only from Undo. Exact or it says no: the stock goes out again only if all of it is still on the shelf.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { undoReturn } from "../returns.js";

export function registerUndoReturnAction(): void {
  platform().actions.registerHandler("sales.undo-return", async (ctx) => {
    const order = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await undoReturn(db, ctx.orgId, ctx.userId, order.id, String((ctx.args as { return_id?: unknown } | null)?.return_id ?? ""));
    return r.ok ? { ok: true } : { ok: false, error: r.message, code: r.code };
  });
}
