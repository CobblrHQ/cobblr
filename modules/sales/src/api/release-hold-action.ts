// Let an order's hold go (sales:release-hold): the handler its manifest entry names. Wired in ./index.ts.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { releaseHold } from "../holds.js";

export function registerReleaseHoldAction(): void {
  platform().actions.registerHandler("sales.release-hold", async (ctx) => {
    const order = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    const r = await releaseHold(db, ctx.orgId, ctx.userId, order.id, "it was released");
    return r.ok ? { ok: true, released: r.released } : { ok: false, error: r.message, code: r.code };
  });
}
