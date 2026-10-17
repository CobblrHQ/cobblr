// Archive a connection (core-integrations:archive-sync-connection): the handler its manifest entry names. Wired in ./index.ts.
// The same write as Archive on the Integrations page (POST …/connections/:id/archive).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { archiveConnection, findSyncConnection, sectionsOf } from "../sync/operations.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function registerArchiveSyncConnectionAction(): void {
  platform().actions.registerPlanner("core-integrations.archive-sync-connection", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreIntegrationsDB>;
    const conn = await findSyncConnection(db, str(ctx.args?.connection));
    if ("error" in conn) return { error: conn.error };
    if (conn.archived_at) return { error: `${conn.label} is already archived.` };
    return { title: `Archive ${conn.label}`, lines: ["Its syncing stops. Nothing it brought in is deleted, and it can be brought back."] };
  });
  platform().actions.registerHandler("core-integrations.archive-sync-connection", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreIntegrationsDB>;
    const conn = await findSyncConnection(db, str(ctx.args?.connection));
    if ("error" in conn) return { ok: false, error: conn.error };
    if (conn.archived_at) return { ok: true, skipped: true, summary: `${conn.label} was already archived.` };
    const sections = await sectionsOf(db, conn.id);
    await archiveConnection(db, conn.id);
    return { ok: true, summary: `${conn.label} is archived and no longer syncs.`, data: { connection: conn.id, sections } };
  });
  // Bringing it back leaves syncing off, so the undo turns back on each section
  // that was syncing when it was archived.
  platform().actions.registerUndo("core-integrations.archive-sync-connection", (result) => {
    const d = (result as { ok?: unknown; skipped?: unknown; data?: { connection?: string; sections?: Array<{ section: string; enabled: boolean; cadence_min: number }> } } | null);
    if (d?.ok !== true || d.skipped || !d.data?.connection) return null;
    const id = d.data.connection;
    return [
      { action_id: "core-integrations:unarchive-sync-connection", args: { connection: id } },
      ...(d.data.sections ?? [])
        .filter((s) => s.enabled)
        .map((s) => ({ action_id: "core-integrations:set-sync", args: { connection: id, section: s.section, enabled: true, cadence_min: s.cadence_min } })),
    ];
  });
}
