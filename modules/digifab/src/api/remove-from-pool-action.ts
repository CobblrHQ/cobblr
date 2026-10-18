// Take a printer out of a pool (digifab:remove-from-pool): the handler its manifest entry names. Wired in ./index.ts.
// The same delete as on the pool's member list (DELETE /pools/:id/members/…):
// the queue stops sending that pool's jobs to it.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { findPool } from "./pool-lookup.js";

export function registerRemoveFromPoolAction(): void {
  platform().actions.registerHandler("digifab.remove-from-pool", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const connectionId = typeof a.connection_id === "string" ? a.connection_id.trim() : "";
    const deviceId = typeof a.device_id === "string" ? a.device_id.trim() : "";
    if (!connectionId || !deviceId) return { ok: false, error: "Say which printer: its connection and device, as read_fabrication_floor lists them." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const pool = await findPool(db, a.pool);
    if ("error" in pool) return { ok: false, error: pool.error };
    const r = await db
      .deleteFrom("digifab_pool_members")
      .where("pool_id", "=", pool.id)
      .where("connection_id", "=", connectionId)
      .where("remote_device_id", "=", deviceId)
      .executeTakeFirst();
    if (!Number(r.numDeletedRows ?? 0)) return { ok: true, skipped: true, summary: `That printer was not in the ${pool.name} pool.` };
    return { ok: true, summary: `Took the printer out of the ${pool.name} pool; its jobs no longer go to it.`, data: { pool: pool.id } };
  });
}
