// PERMANENT RECONCILE — an installed table carries the declarations its
// bundle's current manifest makes for it (bundle-instance-config-plan.ts).
//
// BORN WITH: applyValidatedBundle (an install writes each table's config from the manifest it installs)
//
// A table-level declaration can change what an action does: the Lego Sets
// table says its sets come apart into bricks on Bricks (`parts_into`), and
// Disassemble reads it. An install from before the declaration only learns
// it when the bundle update applies, which waits on the person's prompt
// whenever the update reports a conflict, and until then every set came
// apart onto the general Parts table (#5434).
//
// So this fills only a MISSING key, on a table the workspace's install of
// that bundle provides, from the manifest this image ships. It never replaces
// a value already set. Meta-only: no tenant pool opens.

import { sql } from "kysely";
import { listFlagshipManifests } from "../lib/flagship-bundles.js";
import { planInstanceConfigHeals, type InstanceOverride } from "./bundle-instance-config-plan.js";

/** One pass over every workspace's installed bundles. Returns how many tables
 *  it filled; a current workspace costs two meta reads and writes nothing. */
export async function reconcileBundleInstanceConfig(): Promise<number> {
  const { meta } = await import("../db/meta.js");
  const catalog = new Map(listFlagshipManifests("all").map((m) => [String(m.id ?? ""), m as unknown]));
  const installed = await meta.selectFrom("bundles").select(["org_id", "external_id"]).where("install_status", "=", "active").execute();
  if (!installed.length) return 0;
  const overrides = (await meta
    .selectFrom("entity_kind_overrides")
    .select(["org_id", "target_id", "config"])
    .where("target_kind", "=", "instance")
    .execute()) as InstanceOverride[];
  const patches = planInstanceConfigHeals(installed, catalog, overrides);
  for (const p of patches) {
    // Merged, and only where the key is still missing at write time: a value
    // set since the read is never replaced.
    let q = meta
      .updateTable("entity_kind_overrides")
      .set({ config: sql`coalesce(config, '{}'::jsonb) || ${JSON.stringify(p.patch)}::jsonb` as never, updated_at: new Date() })
      .where("org_id", "=", p.org_id)
      .where("target_kind", "=", "instance")
      .where("target_id", "=", p.target_id);
    for (const k of Object.keys(p.patch)) q = q.where(sql<boolean>`coalesce(config ->> ${k}, '') = ''`);
    await q.execute();
  }
  return patches.length;
}
