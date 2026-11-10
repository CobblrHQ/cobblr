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
    // The Undo of making a pool removes it only while it is still as made:
    // empty. Printers added since, a production run started on it, or a job
    // sent to it would go with it (members and runs cascade), so they keep it.
    if (ctx.args?.only_if_empty === true) {
      const [members, runs, jobs] = await Promise.all([
        db.selectFrom("digifab_pool_members").select(({ fn }) => fn.countAll<string>().as("n")).where("pool_id", "=", pool.id).executeTakeFirst(),
        db.selectFrom("digifab_production_runs").select(({ fn }) => fn.countAll<string>().as("n")).where("pool_id", "=", pool.id).executeTakeFirst(),
        db.selectFrom("digifab_jobs").select(({ fn }) => fn.countAll<string>().as("n")).where("target_pool", "=", pool.id).executeTakeFirst(),
      ]);
      const said = [[Number(members?.n ?? 0), "printer"], [Number(runs?.n ?? 0), "production run"], [Number(jobs?.n ?? 0), "job"]]
        .filter(([n]) => (n as number) > 0)
        .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
      if (said.length) {
        return { ok: false, error: `${said.join(", ")} went into the ${pool.name} pool since it was made, so it stays with everything in it. Nothing was removed.` };
      }
    }
    await db.deleteFrom("digifab_pools").where("id", "=", pool.id).execute(); // members cascade
    return { ok: true, summary: `Removed the ${pool.name} pool. Its printers are still here.`, data: { pool: pool.id } };
  });
}
