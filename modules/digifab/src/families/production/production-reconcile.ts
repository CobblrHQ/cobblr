// PERMANENT RECONCILE: prepared attempts and finished evidence survive a lost bridge response or workspace restart.
// BORN WITH: prepareProductionStation stages and syncProductionAttempt projects and acknowledges each attempt.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../../db.js";
import { stageProductionAttempt, syncProductionAttempt } from "./production-actions.js";
export async function reconcileProductionTests(db: Kysely<DigifabDB>, orgId: string) {
 const pending = await db.selectFrom("digifab_test_delivery").selectAll().where("acknowledged", "=", false).orderBy("updated_at", "asc").limit(20).execute();
 for (const delivery of pending) {
  try {
   if (!delivery.staged) await stageProductionAttempt(db, orgId, delivery.run_id);
   const run = await db.selectFrom("digifab_test_runs").selectAll().where("id", "=", delivery.run_id).executeTakeFirstOrThrow();
   if (run.result) await syncProductionAttempt(db, orgId, delivery.run_id);
   else if (run.bridge_connection_id) {
    const driver = await platform().devices.getDriver(orgId, run.bridge_connection_id);
    if (driver && "productionRequest" in driver && typeof driver.productionRequest === "function") {
     const state = await driver.productionRequest("read", { workspace_id: orgId }) as { attempts: Array<{ id: string; status: string }> };
     if (state.attempts.some(a => a.id === run.id && a.status === "finished")) await syncProductionAttempt(db, orgId, run.id);
    }
   }
   await db.updateTable("digifab_test_delivery").set({ last_error: null, updated_at: new Date() }).where("run_id", "=", delivery.run_id).execute();
  } catch (error) {
   platform().health.notePassFailure("digifab.production-test-sync", orgId, error);
   await db.updateTable("digifab_test_delivery").set({ last_error: error instanceof Error ? error.message : "Reconnect this station to sync its evidence.", updated_at: new Date() }).where("run_id", "=", delivery.run_id).execute();
  }
 }
 return { found: pending.length, settled: pending.length === 0 };
}
let registered = false;
export function registerProductionReconcile() {
 if (registered) return; registered = true;
 platform().sweeps.register({ name: "digifab.production-test-sync", module: "digifab", everyMs: 30_000, firstAfterMs: 30_000, visit: async ({ orgId, db }) => { await reconcileProductionTests(db as Kysely<DigifabDB>, orgId); } });
}
