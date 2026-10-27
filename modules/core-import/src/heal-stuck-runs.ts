// DONE WHEN: no core_import_runs row made before the fix still reads "running" with no worker beating.
// BORN WITH: runImport beats while it works and carries on after a restart (claimRun, the resume point).
//
// A run cut off by a restart before #8656 said "running" forever: nothing
// would ever pick it up again, and Undo refused while it "ran". Each one gets
// a job again; the job carries it on, or, when its rows cannot be placed,
// ends it as failed so Undo can take back what came in. Only runs older than
// any import can take are touched, so one an older server is still carrying
// while this one starts is left to it.
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import type { ImportDb } from "./db.js";
import { SHEET_IMPORT_QUEUE } from "./services/sheet-import.js";

const OLDER_THAN_ANY_IMPORT_MS = 3 * 60 * 60_000;

export function registerStuckImportRunsHeal(): void {
  registerHealPass({ name: "core-import.stuck-runs", since: "2026-10-27T13:00:00Z", shim: "modules/core-import/src/heal-stuck-runs.ts", module: "core-import", visit: async ({ orgId, db, since }) => {
    const stuck = await (db as ImportDb).selectFrom("core_import_runs").select("id")
      .where("status", "=", "running").where("heartbeat_at", "is", null)
      .where("created_at", "<", since).where("created_at", "<", new Date(Date.now() - OLDER_THAN_ANY_IMPORT_MS))
      .execute();
    for (const run of stuck) await platform().queue.enqueue({ orgId, queue: SHEET_IMPORT_QUEUE, payload: { runId: run.id }, idempotencyKey: `${run.id}:heal` });
    return stuck.length;
  } });
}
