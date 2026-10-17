// Turn a sync on or off (core-integrations:set-sync): the handler its manifest entry names. Wired in ./index.ts.
// The same write as the section's switch on the Integrations page (PUT …/syncs/:entityType).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { findSyncConnection, loadSection, sectionSync, setSectionSync } from "../sync/operations.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function readArgs(args: Record<string, unknown>): { enabled: boolean; cadence?: number } | { error: string } {
  const e = args.enabled;
  const enabled = e === true || e === "true" ? true : e === false || e === "false" ? false : null;
  if (enabled === null) return { error: "Say whether to turn it on or off." };
  if (args.cadence_min == null || args.cadence_min === "") return { enabled };
  const cadence = Number(args.cadence_min);
  if (!Number.isInteger(cadence) || cadence < 1 || cadence > 1440) return { error: "How often is a whole number of minutes from 1 to 1440." };
  return { enabled, cadence };
}

async function resolve(orgId: string, args: Record<string, unknown>) {
  const read = readArgs(args);
  if ("error" in read) return read;
  const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreIntegrationsDB>;
  const conn = await findSyncConnection(db, str(args.connection));
  if ("error" in conn) return { error: conn.error };
  if (conn.archived_at) return { error: `${conn.label} is archived; bring it back first.` };
  const rt = await loadSection(db, orgId, conn.id, str(args.section));
  if ("error" in rt) return { error: rt.error === "not_found" ? `${conn.label} is turned off.` : rt.message };
  return { db, conn, ...rt, ...read };
}

const every = (min: number | undefined) => (min ? `, every ${min} minute${min === 1 ? "" : "s"}` : "");

export function registerSetSyncAction(): void {
  platform().actions.registerPlanner("core-integrations.set-sync", async (ctx) => {
    const r = await resolve(ctx.orgId, ctx.args ?? {});
    if ("error" in r) return { error: r.error };
    return { title: `${r.enabled ? "Sync" : "Stop syncing"} ${r.type.label} from ${r.conn.label}${r.enabled ? every(r.cadence) : ""}`, lines: [] };
  });
  platform().actions.registerHandler("core-integrations.set-sync", async (ctx) => {
    const r = await resolve(ctx.orgId, ctx.args ?? {});
    if ("error" in r) return { ok: false, error: r.error };
    const before = await sectionSync(r.db, r.conn.id, r.type.key);
    await setSectionSync(r.db, ctx.orgId, r.conn.id, r.type.key, r.enabled, r.cadence);
    const imported = !!(
      await r.db
        .selectFrom("core_integrations_sync_state")
        .select(["import_approved_at"])
        .where("connector_row_id", "=", r.conn.id)
        .where("entity_type", "=", r.type.key)
        .executeTakeFirst()
    )?.import_approved_at;
    const on = `${r.type.label} from ${r.conn.label} syncs${every(r.cadence)}`;
    return {
      ok: true,
      summary: !r.enabled
        ? `${r.type.label} from ${r.conn.label} no longer syncs.`
        : imported
          ? `${on}.`
          : `${on} once its first import is approved on the Integrations page.`,
      data: { connection: r.conn.id, section: r.type.key, enabled: r.enabled, before },
    };
  });
}
