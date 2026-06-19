// HISTORICAL DATA MIGRATION — not kernel logic.
//
// The machine-specialisation bundles (3D Printers / Laser Cutters / CNC
// Machines) ship a default-on "Connect to your machines" feature that brings
// digifab (the Print Manager) under their roof. Installs that PREDATE that
// feature have the bundle but digifab OFF — so there's no Print Manager, no way
// to connect a printer to FDM Monster / OctoPrint / Bambu, and the machine's
// detail "Print manager" panel never shows.
//
// This reconciler enables digifab for any org that has one of those bundles but
// doesn't have digifab on yet. Additive + idempotent: enableModuleForOrg no-ops
// when the module is already enabled, and we skip orgs that already have the
// row. Runs the module's tenant migrations inline (enable.ts), so the digifab
// tables are provisioned in one shot.
//
// the author's rule: a shipped feature must self-heal existing installs — never make a
// user uninstall+reinstall (or hunt in Configuration) to get what the bundle
// promised. Skip with COBBLR_SKIP_HISTORICAL_MIGRATIONS=1. Deletable once every
// machine-bundle org reads orgsEnabled=0.

import { meta } from "../db/meta.js";
import { enableModuleForOrg } from "../modules/enable.js";
import { evictTenantPool } from "../db/tenant.js";

const MACHINE_BUNDLE_IDS = [
  "cobblr.community.3d-printers",
  "cobblr.community.laser-cutters",
  "cobblr.community.cnc-machines",
];

export async function enableDigifabForMachineBundles(): Promise<{ orgsEnabled: number }> {
  if (process.env.COBBLR_SKIP_HISTORICAL_MIGRATIONS === "1") {
    return { orgsEnabled: 0 };
  }
  const rows = await meta
    .selectFrom("bundles")
    .select("org_id")
    .distinct()
    .where("external_id", "in", MACHINE_BUNDLE_IDS)
    .execute();
  if (rows.length === 0) return { orgsEnabled: 0 };

  let orgsEnabled = 0;
  for (const { org_id } of rows) {
    const already = await meta
      .selectFrom("org_modules")
      .select("module_name")
      .where("org_id", "=", org_id)
      .where("module_name", "=", "digifab") // HISTORICAL DATA MIGRATION names the module it heals
      .executeTakeFirst();
    if (already) continue;
    try {
      await enableModuleForOrg(org_id, "digifab"); // HISTORICAL DATA MIGRATION names the module it heals
      orgsEnabled++;
    } catch (err) {
      console.error(`[enable-digifab] org ${org_id} failed:`, (err as Error).message);
    } finally {
      // enable runs the digifab tenant migrations → opens a pool; don't leave it
      // cached open across the whole boot sweep (pre-listen connection budget).
      await evictTenantPool(org_id);
    }
  }
  return { orgsEnabled };
}
