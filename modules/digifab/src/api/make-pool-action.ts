// Make a printer pool (digifab:make-pool): the handler its manifest entry names. Wired in ./index.ts.
// The same insert as New pool (POST /pools). An empty pool: printers are added at its page.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { makePool } from "./pools.js";

export function registerMakePoolAction(): void {
  platform().actions.registerHandler("digifab.make-pool", async (ctx) => {
    const name = typeof ctx.args?.name === "string" ? ctx.args.name.trim().slice(0, 120) : "";
    if (!name) return { ok: false, error: "Say what to call the pool." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const row = await makePool(db as never, name);
    return { ok: true, summary: `Made the ${row.name} pool. Add printers to it on its page.`, data: { pool: row.id } };
  });
  platform().actions.registerUndo("digifab.make-pool", (result) => {
    const d = (result as { ok?: unknown; data?: { pool?: string } } | null);
    if (d?.ok !== true || !d.data?.pool) return null;
    return { action_id: "digifab:remove-pool", args: { pool: d.data.pool } };
  });
}
