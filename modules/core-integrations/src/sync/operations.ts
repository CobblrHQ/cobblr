// What a person does to a sync connection that holds no secret: run it now,
// switch a section's live sync, archive or bring it back, test it. One body
// each, shared by the HTTP routes (api/sync.ts) and the workspace actions
// (api/sync-actions.ts), so a press and an assistant's call cannot mean two
// different things.

import { platform, type SyncEntityType } from "@cobblr/platform-contract";
import { sql, type Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { loadConnectionRef } from "./connection.js";
import { ReconcileBusyError, fetchCtx, runReconcile, runStatusOf, type ReconcileResult, type SyncConnectionRef } from "./engine.js";
import { installedSyncConnectors, resolveSyncConnector } from "./resolve.js";
import { DEFAULT_CADENCE_MIN, ensureSyncScan } from "./worker.js";

type Db = Kysely<CoreIntegrationsDB>;

export async function syncConnectorIds(db: Db): Promise<Set<string>> {
  return new Set([
    ...platform().integrations.listSyncConnectors().map((c) => c.id),
    ...(await installedSyncConnectors(db)).map((c) => c.id),
  ]);
}

/** The sync connection a person named, by id or by its label (any case). */
export async function findSyncConnection(
  db: Db,
  named: string,
): Promise<{ id: string; label: string; connector_id: string; archived_at: Date | null } | { error: string }> {
  const want = named.trim();
  if (!want) return { error: "Say which connection." };
  const ids = await syncConnectorIds(db);
  const rows = (await db.selectFrom("core_integrations_connectors").select(["id", "label", "connector_id", "archived_at"]).execute()).filter((r) =>
    ids.has(r.connector_id),
  );
  const byId = rows.find((r) => r.id === want);
  if (byId) return byId;
  const byLabel = rows.filter((r) => r.label.toLowerCase() === want.toLowerCase());
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) return { error: `More than one connection is called "${want}"; say which by its id.` };
  const names = rows.map((r) => r.label);
  return { error: names.length ? `No sync connection called "${want}". There is ${names.join(", ")}.` : "This workspace has no sync connections." };
}

/** The section (entity type) of an active connection, by key or label. */
export async function loadSection(
  db: Db,
  orgId: string,
  connectionId: string,
  section: string,
): Promise<{ ref: SyncConnectionRef; type: SyncEntityType } | { error: "not_found" | "unknown_type"; message: string }> {
  const ref = await loadConnectionRef(db, orgId, connectionId);
  if (!ref) return { error: "not_found", message: "connection not found / disabled" };
  const def = await resolveSyncConnector(db, ref.connectorId);
  const want = section.trim().toLowerCase();
  const types = def?.entityTypes ?? [];
  const type = types.find((t) => t.key === section) ?? types.find((t) => t.key.toLowerCase() === want || t.label.toLowerCase() === want);
  if (!type) {
    const offered = types.map((t) => t.label).join(", ");
    return { error: "unknown_type", message: offered ? `This connection syncs ${offered}, not "${section}".` : "entity type not offered by this connector" };
  }
  return { ref, type };
}

export type SyncNowOutcome =
  | { ok: true; result: ReconcileResult }
  | { ok: false; code: "not_imported" | "busy" | "failed"; message: string };

/** A live reconcile of one section, after its first import was approved. */
export async function syncNow(db: Db, ref: SyncConnectionRef, type: SyncEntityType): Promise<SyncNowOutcome> {
  const state = await db
    .selectFrom("core_integrations_sync_state")
    .select(["import_approved_at"])
    .where("connector_row_id", "=", ref.connectorRowId)
    .where("entity_type", "=", type.key)
    .executeTakeFirst();
  if (!state?.import_approved_at) return { ok: false, code: "not_imported", message: "run the import preview + approve it first" };
  try {
    const result = await runReconcile(db, ref, type); // live: no name-merge
    // A manual run is the poll's run: push its next turn a cadence out, for
    // the same reason the import does (#2880).
    await db
      .updateTable("core_integrations_sync_state")
      .set({
        last_run_at: new Date(),
        ...runStatusOf(result),
        last_synced_count: result.total,
        next_run_at: sql`now() + make_interval(mins => coalesce(cadence_min, ${DEFAULT_CADENCE_MIN}))`,
        updated_at: new Date(),
      })
      .where("connector_row_id", "=", ref.connectorRowId)
      .where("entity_type", "=", type.key)
      .execute();
    return { ok: true, result };
  } catch (e) {
    // A busy sync has not failed, so it must not be written down as failed:
    // last_status would read "error" until the next successful run and the
    // connection would look broken on the page.
    if (e instanceof ReconcileBusyError) return { ok: false, code: "busy", message: e.message };
    await db
      .updateTable("core_integrations_sync_state")
      .set({ last_run_at: new Date(), last_status: "error", last_error: (e as Error).message, updated_at: new Date() })
      .where("connector_row_id", "=", ref.connectorRowId)
      .where("entity_type", "=", type.key)
      .execute();
    return { ok: false, code: "failed", message: (e as Error).message };
  }
}

export interface SectionSync {
  enabled: boolean;
  cadence_min: number;
}

/** A section's live sync as it stands, or null when it was never set. */
export async function sectionSync(db: Db, connectionId: string, entityType: string): Promise<SectionSync | null> {
  const row = await db
    .selectFrom("core_integrations_sync_state")
    .select(["enabled", "cadence_min"])
    .where("connector_row_id", "=", connectionId)
    .where("entity_type", "=", entityType)
    .executeTakeFirst();
  return row ? { enabled: !!row.enabled, cadence_min: row.cadence_min ?? DEFAULT_CADENCE_MIN } : null;
}

/** Every section's live sync on a connection, for an undo that turns back on
 *  what an archive switched off. */
export async function sectionsOf(db: Db, connectionId: string): Promise<Array<{ section: string } & SectionSync>> {
  const rows = await db
    .selectFrom("core_integrations_sync_state")
    .select(["entity_type", "enabled", "cadence_min"])
    .where("connector_row_id", "=", connectionId)
    .execute();
  return rows.map((r) => ({ section: r.entity_type, enabled: !!r.enabled, cadence_min: r.cadence_min ?? DEFAULT_CADENCE_MIN }));
}

/** Switch a section's live sync and cadence. Live sync only starts once the
 *  first import is approved; before that the row stays in PREVIEW (next_run_at
 *  null) whatever the flag says. */
export async function setSectionSync(
  db: Db,
  orgId: string,
  connectionId: string,
  entityType: string,
  enabled: boolean,
  cadenceMin?: number,
): Promise<void> {
  const cadence = cadenceMin ?? DEFAULT_CADENCE_MIN;
  const existing = await db
    .selectFrom("core_integrations_sync_state")
    .select(["import_approved_at"])
    .where("connector_row_id", "=", connectionId)
    .where("entity_type", "=", entityType)
    .executeTakeFirst();
  const approved = !!existing?.import_approved_at;
  const nextRun = enabled && approved ? new Date() : null;
  await db
    .insertInto("core_integrations_sync_state")
    .values({ connector_row_id: connectionId, entity_type: entityType, enabled, cadence_min: cadence, next_run_at: nextRun })
    .onConflict((oc) =>
      oc.columns(["connector_row_id", "entity_type"]).doUpdateSet({ enabled, cadence_min: cadence, next_run_at: nextRun, updated_at: new Date() }),
    )
    .execute();
  if (enabled && approved) await ensureSyncScan(orgId);
}

/** Move a connection to the history section (NOT delete). Turns off ongoing
 *  sync so the poll worker drops it; the id-map + config survive, so
 *  un-archive resumes it. run/preview/import 404 while archived. */
export async function archiveConnection(db: Db, connectionId: string): Promise<void> {
  await db.updateTable("core_integrations_connectors").set({ archived_at: new Date(), updated_at: new Date() }).where("id", "=", connectionId).execute();
  await db
    .updateTable("core_integrations_sync_state")
    .set({ enabled: false, next_run_at: null, updated_at: new Date() })
    .where("connector_row_id", "=", connectionId)
    .execute();
}

/** One click back to the normal list. Sync stays OFF (archiving is not the
 *  same as disabling ongoing sync); a person re-enables it if they want. */
export async function unarchiveConnection(db: Db, connectionId: string): Promise<void> {
  await db.updateTable("core_integrations_connectors").set({ archived_at: null, updated_at: new Date() }).where("id", "=", connectionId).execute();
}

/** Ask the source whether the stored credentials still work. What comes back
 *  is the connector's verdict, never the credentials. */
export async function testSyncConnection(
  db: Db,
  orgId: string,
  connectionId: string,
): Promise<{ found: false } | { found: true; ok: boolean; note?: string; error?: string }> {
  const ref = await loadConnectionRef(db, orgId, connectionId);
  if (!ref) return { found: false };
  const def = await resolveSyncConnector(db, ref.connectorId);
  if (!def?.testConnection) return { found: true, ok: true, note: "connector has no test" };
  const result = (await def.testConnection(fetchCtx(ref))) as {
    ok: boolean;
    error?: string;
    note?: string;
  };
  return { found: true, ...result };
}
