// PERMANENT RECONCILE: a managed app's own table is where its unmatched scans land.
//
// A locked app has ONE table the person knows about (Groceries, Home
// Inventory, Yarn). The scan matchmaker sends an item that matches no table in
// particular to the module's fallback, and absent a pick that is the module's
// DEFAULT instance, the plain "Inventory" the app never shows. So a grocery app
// walked on staging offered "Inventory" for a can of soup and a bag of chips
// (2026-09-02): a door onto a table the app hides. Provisioning now points the
// fallback at the app's instance; this pass does the same for every app
// workspace that was provisioned before it did, at boot, idempotently.
//
// Cheap on the happy path: two cobblr_meta reads, no tenant pool. Only an app
// workspace whose instance exists and is not yet the fallback does a write.

import { meta } from "../db/meta.js";
import { getManagedApp } from "./managed-apps.js";
import { setScanFallback } from "./instances.js";

export async function reconcileAppScanFallback(): Promise<{ orgsChecked: number; orgsHealed: number }> {
  const orgs = await meta
    .selectFrom("orgs")
    .select(["id", "app_mode"])
    .where("app_mode", "is not", null)
    .execute();
  if (orgs.length === 0) return { orgsChecked: 0, orgsHealed: 0 };
  const instances = await meta
    .selectFrom("workspace_module_instances")
    .select(["org_id", "instance_name", "is_scan_fallback"])
    .where("org_id", "in", orgs.map((o) => o.id))
    .execute();
  const byOrg = new Map<string, Map<string, boolean>>();
  for (const i of instances) {
    const m = byOrg.get(i.org_id) ?? new Map<string, boolean>();
    m.set(i.instance_name, i.is_scan_fallback);
    byOrg.set(i.org_id, m);
  }
  let healed = 0;
  for (const org of orgs) {
    const app = getManagedApp((org.app_mode as { app?: string } | null)?.app ?? "");
    if (!app) continue;
    const isFallback = byOrg.get(org.id)?.get(app.instanceName);
    if (isFallback === undefined || isFallback) continue;
    try {
      await setScanFallback(org.id, app.instanceName);
      healed += 1;
      console.log(`[reconcile] org ${org.id}: scan fallback -> ${app.instanceName} (${app.id} app)`);
    } catch (err) {
      console.error(`[reconcile] org ${org.id}: scan fallback for ${app.id} failed:`, (err as Error).message);
    }
  }
  return { orgsChecked: orgs.length, orgsHealed: healed };
}
