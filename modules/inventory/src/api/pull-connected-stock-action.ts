// Pull stock from a connected Spoolman (inventory:pull-connected-stock): the handler its manifest entry names. Wired in ./index.ts.
// The same pull as Sync on the Spoolman connection (POST /spoolman/sync); the key is never shown.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { InventoryDB } from "../db.js";
import { syncSpoolman } from "./spoolman.js";

export function registerPullConnectedStockAction(): void {
  platform().actions.registerHandler("inventory.pull-connected-stock", async (ctx) => {
    const want = typeof ctx.args?.connection === "string" ? ctx.args.connection.trim() : "";
    const conns = (await platform().devices.connections().list(ctx.orgId)).filter((c) => c.type === "spoolman");
    if (!conns.length) return { ok: false, error: "No Spoolman is connected." };
    const named = want ? conns.filter((c) => c.id === want || c.label.toLowerCase() === want.toLowerCase()) : conns.length === 1 ? conns : [];
    if (named.length !== 1) return { ok: false, error: `Say which Spoolman: ${conns.map((c) => c.label).join(", ")}.` };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<InventoryDB>;
    const out = await syncSpoolman(db, ctx.orgId, named[0]!.id, {});
    if (out.status !== 200) return { ok: false, error: out.code === "spoolman_unreachable" ? `${named[0]!.label} did not answer: ${out.message}` : out.message };
    return { ok: true, summary: `Synced ${out.synced} spool${out.synced === 1 ? "" : "s"} from ${named[0]!.label}: ${out.created} new, ${out.updated} updated.`, data: out };
  });
}
