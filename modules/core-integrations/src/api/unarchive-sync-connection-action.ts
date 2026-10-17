// Bring a connection back (core-integrations:unarchive-sync-connection): the handler its manifest entry names. Wired in ./index.ts.
// The same write as Bring back on the Integrations page (POST …/connections/:id/unarchive).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { findSyncConnection, unarchiveConnection } from "../sync/operations.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function registerUnarchiveSyncConnectionAction(): void {
  platform().actions.registerPlanner("core-integrations.unarchive-sync-connection", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreIntegrationsDB>;
    const conn = await findSyncConnection(db, str(ctx.args?.connection));
    if ("error" in conn) return { error: conn.error };
    if (!conn.archived_at) return { error: `${conn.label} is not archived.` };
    return { title: `Bring ${conn.label} back`, lines: ["Its syncing stays off until someone turns it on."] };
  });
  platform().actions.registerHandler("core-integrations.unarchive-sync-connection", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreIntegrationsDB>;
    const conn = await findSyncConnection(db, str(ctx.args?.connection));
    if ("error" in conn) return { ok: false, error: conn.error };
    if (!conn.archived_at) return { ok: true, skipped: true, summary: `${conn.label} was not archived.` };
    await unarchiveConnection(db, conn.id);
    return { ok: true, summary: `${conn.label} is back in the list. Its syncing is off until someone turns it on.`, data: { connection: conn.id } };
  });
  platform().actions.registerUndo("core-integrations.unarchive-sync-connection", (result) => {
    const d = (result as { ok?: unknown; skipped?: unknown; data?: { connection?: string } } | null);
    if (d?.ok !== true || d.skipped || !d.data?.connection) return null;
    return { action_id: "core-integrations:archive-sync-connection", args: { connection: d.data.connection } };
  });
}
