// Remove a printer pool (digifab:remove-pool): the handler its manifest entry names. Wired in ./index.ts.
// The same delete as on the pool (DELETE /pools/:id): its printers stay.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { findPool } from "./pool-lookup.js";

export function registerRemovePoolAction(): void {
  platform().actions.registerHandler("digifab.remove-pool", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const pool = await findPool(db, ctx.args?.pool);
    if ("error" in pool) return { ok: false, error: pool.error };
    await db.deleteFrom("digifab_pools").where("id", "=", pool.id).execute(); // members cascade
    return { ok: true, summary: `Removed the ${pool.name} pool. Its printers are still here.`, data: { pool: pool.id } };
  });
}
