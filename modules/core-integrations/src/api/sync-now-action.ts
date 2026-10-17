// Sync now (core-integrations:sync-now): the handler its manifest entry names. Wired in ./index.ts.
// The same live reconcile as the page's "Sync now" (POST …/syncs/:entityType/run).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { findSyncConnection, loadSection, syncNow } from "../sync/operations.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function resolve(orgId: string, args: Record<string, unknown>) {
  const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreIntegrationsDB>;
  const conn = await findSyncConnection(db, str(args.connection));
  if ("error" in conn) return { error: conn.error };
  if (conn.archived_at) return { error: `${conn.label} is archived; bring it back before syncing it.` };
  const rt = await loadSection(db, orgId, conn.id, str(args.section));
  if ("error" in rt) return { error: rt.error === "not_found" ? `${conn.label} is turned off.` : rt.message };
  return { db, conn, ...rt };
}

export function registerSyncNowAction(): void {
  platform().actions.registerPlanner("core-integrations.sync-now", async (ctx) => {
    const r = await resolve(ctx.orgId, ctx.args ?? {});
    if ("error" in r) return { error: r.error! };
    return { title: `Sync ${r.type.label} from ${r.conn.label} now`, lines: ["Brings in what changed at the source since the last run."] };
  });
  platform().actions.registerHandler("core-integrations.sync-now", async (ctx) => {
    const r = await resolve(ctx.orgId, ctx.args ?? {});
    if ("error" in r) return { ok: false, error: r.error };
    const out = await syncNow(r.db, r.ref, r.type);
    if (!out.ok) {
      const error =
        out.code === "not_imported"
          ? `${r.type.label} from ${r.conn.label} has not been imported yet. Look over its import preview on the Integrations page and approve it first.`
          : out.code === "busy"
            ? `${r.type.label} from ${r.conn.label} is already syncing; try again in a moment.`
            : `${r.conn.label} did not answer: ${out.message}`;
      return { ok: false, error };
    }
    const x = out.result;
    const said = [`${x.created} new`, `${x.updated} updated`, ...(x.tombstoned ? [`${x.tombstoned} gone at the source`] : [])];
    const warn = x.failed.length + x.unmapped.length + x.conflicts.length;
    return {
      ok: true,
      summary: `Synced ${r.type.label} from ${r.conn.label}: ${said.join(", ")}${warn ? `, and ${warn} to look at on the Integrations page` : ""}.`,
      data: { created: x.created, updated: x.updated, linked: x.linked, gone: x.tombstoned, total: x.total, failed: x.failed, unmapped: x.unmapped },
    };
  });
}
