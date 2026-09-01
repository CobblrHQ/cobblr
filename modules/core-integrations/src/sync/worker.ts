// The reconcile poll — the safety net behind the live webhook.
//
// ONE self-rescheduling scan job per workspace (not per sync), so enabling N
// syncs never spawns N chains. Each tick reconciles the syncs whose next_run_at
// is due, then re-enqueues itself ~2 min out while any sync is still enabled.
// Cadence is per-sync (sync_state.cadence_min); the scan interval just bounds
// how soon a due sync is picked up.

import { platform } from "@cobblr/platform-contract";
import { type Kysely } from "kysely";
import type { CoreIntegrationsDB } from "../db.js";
import { loadConnectionRef } from "./connection.js";
import { ReconcileBusyError, runReconcile } from "./engine.js";
import { resolveSyncConnector } from "./resolve.js";

const SCAN_QUEUE = "core-integrations.sync-scan";
const SCAN_INTERVAL_MS = 2 * 60_000;

let registered = false;

export function registerSyncWorker(): void {
  if (registered) return;
  registered = true;

  platform().queue.registerWorker(SCAN_QUEUE, async (job) => {
    const orgId = job.orgId;
    const db = (await platform().tenants.getDb(orgId)) as Kysely<CoreIntegrationsDB>;
    const now = new Date();

    const due = await db
      .selectFrom("core_integrations_sync_state")
      .selectAll()
      .where("enabled", "=", true)
      .where("import_approved_at", "is not", null) // live sync only after the import is approved
      .where((eb) => eb.or([eb("next_run_at", "is", null), eb("next_run_at", "<=", now)]))
      .execute();

    for (const s of due) {
      let status = "ok";
      let error: string | null = null;
      let count = 0;
      try {
        const ref = await loadConnectionRef(db, orgId, s.connector_row_id);
        const def = ref ? await resolveSyncConnector(db, ref.connectorId) : null;
        const type = def?.entityTypes.find((t) => t.key === s.entity_type);
        if (!ref || !type) throw new Error("connection or entity type unavailable");
        const r = await runReconcile(db, ref, type);
        count = r.total;
      } catch (e) {
        // Another reconcile of this sync is mid-flight (a person pressed
        // Import, or a webhook arrived). That is not a failure: leave
        // next_run_at alone below and this tick simply yields to it.
        if (e instanceof ReconcileBusyError) continue;
        status = "error";
        error = (e as Error).message;
      }
      await db
        .updateTable("core_integrations_sync_state")
        .set({
          last_run_at: now,
          last_status: status,
          last_error: error,
          last_synced_count: count,
          next_run_at: new Date(Date.now() + (s.cadence_min ?? 20) * 60_000),
          updated_at: new Date(),
        })
        .where("connector_row_id", "=", s.connector_row_id)
        .where("entity_type", "=", s.entity_type)
        .execute();
    }

    // Keep the scan alive only while at least one LIVE (approved) sync exists.
    const stillEnabled = await db
      .selectFrom("core_integrations_sync_state")
      .select("entity_type")
      .where("enabled", "=", true)
      .where("import_approved_at", "is not", null)
      .limit(1)
      .executeTakeFirst();
    if (stillEnabled) {
      await platform().queue.enqueue({
        orgId,
        queue: SCAN_QUEUE,
        payload: {},
        runAt: new Date(Date.now() + SCAN_INTERVAL_MS),
      });
    }
  });
}

/** Ensure the workspace's scan loop is running (called when a sync is enabled).
 *  Dedup'd by queue so re-enabling never spawns a second chain. */
export async function ensureSyncScan(orgId: string): Promise<void> {
  const pending = await platform().queue.hasPendingJob({ orgIds: [orgId], queue: SCAN_QUEUE });
  if (!pending.has(orgId)) {
    await platform().queue.enqueue({ orgId, queue: SCAN_QUEUE, payload: {}, runAt: new Date(Date.now() + 5_000) });
  }
}
