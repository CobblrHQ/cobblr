// A bundle's number fields add up the way the bundle now says (#5079).
//
// BORN WITH: applyValidatedBundleUnlocked (installing a bundle writes each field's aggregate through fieldDefRow)
//
// PERMANENT RECONCILE. A grouped table totalled every number field, so a
// yarn's length per ball, a filament's nozzle temperature and a set's release
// year were added up across a group. Each shipped bundle's number fields now
// declare how they add up (`aggregate`, lint:bundle-number-fields-say-how-they-add-up),
// and a workspace that installed the bundle before it said so would keep the
// old sums until somebody updated the bundle. Every boot, a field still
// without a word (aggregate null) on an installed bundle takes the manifest's.
// A person's own choice (aggregate set) is never overwritten.
//
// Cost: cobblr_meta only, no tenant pool. One UPDATE per declared field across
// every workspace at once; on a settled instance each changes no rows.

import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { listFlagshipManifests } from "../lib/flagship-bundles.js";
import { notePassFailure } from "./pass-failures.js";

type Declared = { bundle: string; name: string; aggregate: string };

/** Every (bundle, field, aggregate) the shipped bundles declare, wherever in
 *  the manifest the field sits (top-level field_defs, an instance's, a
 *  feature's). */
export function declaredAggregates(manifests: readonly unknown[]): Declared[] {
  const out: Declared[] = [];
  for (const raw of manifests) {
    const m = ((raw as { manifest?: unknown }).manifest ?? raw) as { id?: string };
    if (!m.id) continue;
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (!o || typeof o !== "object") return;
      const f = o as Record<string, unknown>;
      if (typeof f.name === "string" && typeof f.aggregate === "string" && typeof f.display_label === "string") {
        out.push({ bundle: m.id!, name: f.name, aggregate: f.aggregate });
      }
      for (const v of Object.values(f)) walk(v);
    };
    walk(m);
  }
  return out;
}

export async function reconcileBundleFieldAggregates(manifests: readonly unknown[] = listFlagshipManifests("all")): Promise<{ updated: number; failed: number }> {
  let updated = 0;
  let failed = 0;
  for (const d of declaredAggregates(manifests)) {
    try {
      const r = await sql`
        update module_field_defs f
           set aggregate = ${d.aggregate}
          from bundles b
         where f.bundle_id = b.id
           and b.external_id = ${d.bundle}
           and f.name = ${d.name}
           and f.aggregate is null`.execute(meta);
      updated += Number(r.numAffectedRows ?? 0);
    } catch (err) {
      failed++;
      notePassFailure("reconcileBundleFieldAggregates", `${d.bundle}/${d.name}`, err);
    }
  }
  if (updated) console.log(`[reconcile] bundle field aggregates: ${updated} field(s) now say how they add up`);
  return { updated, failed };
}
