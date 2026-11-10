// Let an order's hold go (sales:release-hold): the handler its manifest entry names. Wired in ./index.ts.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { SalesDB } from "../db.js";
import { releaseHold, undoHold } from "../holds.js";

export function registerReleaseHoldAction(): void {
  platform().actions.registerHandler("sales.release-hold", async (ctx) => {
    const order = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<SalesDB>;
    // The Undo of one hold names it: only that hold, while the order still has it (#9421).
    const a = (ctx.args ?? {}) as { held_at?: unknown; previous?: unknown };
    if (typeof a.held_at === "string") {
      const prev = a.previous && typeof a.previous === "object" ? { until: typeof (a.previous as { until?: unknown }).until === "string" ? ((a.previous as { until: string }).until) : null } : null;
      const u = await undoHold(db, ctx.orgId, ctx.userId, order.id, { held_at: a.held_at, previous: prev });
      return u.ok ? u : { ok: false, error: u.message, code: u.code };
    }
    const r = await releaseHold(db, ctx.orgId, ctx.userId, order.id, "it was released");
    return r.ok ? { ok: true, released: r.released } : { ok: false, error: r.message, code: r.code };
  });
}
