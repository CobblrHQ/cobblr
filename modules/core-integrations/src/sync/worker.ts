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
import { ReconcileBusyError, runReconcile, runStatusOf } from "./engine.js";
import { resolveSyncConnector } from "./resolve.js";

const SCAN_QUEUE = "core-integrations.sync-scan";
const SCAN_INTERVAL_MS = 2 * 60_000;
/** How often a live sync polls when nobody set a cadence. The import and
 *  run routes push next_run_at this far out after their own reconcile, so
 *  the poll never re-does what a person just did (#2880). */
export const DEFAULT_CADENCE_MIN = 20;

/** What a section's state row becomes when its source stops offering it: off,
 *  with the reason where the person reads it. A warning, not an error: nothing
 *  failed, the section is simply gone. */
export function goneSectionState(section: string, source: string): {
  enabled: false;
  next_run_at: null;
  last_status: "warning";
  last_error: string;
} {
  return {
    enabled: false,
    next_run_at: null,
    last_status: "warning",
    last_error: `${source} no longer has a "${section}" section, so it was switched off.`,
  };
}

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
      let conflicts: ReturnType<typeof runStatusOf>["last_conflicts"] | null = null;
      try {
        const ref = await loadConnectionRef(db, orgId, s.connector_row_id);
        const def = ref ? await resolveSyncConnector(db, ref.connectorId) : null;
        const type = def?.entityTypes.find((t) => t.key === s.entity_type);
        // A section the source no longer offers (a printers section folded
        // into machines) can never run again: switch it off, once, and say
        // why, instead of an error on every poll for ever.
        if (ref && def && !type) {
          await db
            .updateTable("core_integrations_sync_state")
            .set({ ...goneSectionState(s.entity_type, def.label), updated_at: new Date() })
            .where("connector_row_id", "=", s.connector_row_id)
            .where("entity_type", "=", s.entity_type)
            .execute();
          continue;
        }
        if (!ref || !type) throw new Error("connection or entity type unavailable");
        const r = await runReconcile(db, ref, type);
        count = r.total;
        // A value the run could not map was left alone; say so on the sync.
        ({ last_status: status, last_error: error, last_conflicts: conflicts } = runStatusOf(r));
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
          ...(conflicts ? { last_conflicts: conflicts } : {}),
          last_synced_count: count,
          next_run_at: new Date(Date.now() + (s.cadence_min ?? DEFAULT_CADENCE_MIN) * 60_000),
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
