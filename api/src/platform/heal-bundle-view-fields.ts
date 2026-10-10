// PERMANENT RECONCILE — a view a bundle seeded names fields its kind has, as
// the shipped bundle now defines it.
//
// BORN WITH: applyValidatedBundle (an install seeds each view from the manifest it installs)
//
// Lego 0.6.4 pinned "By part category" grouped by `category`, a label and not
// a field the bricks have; 0.6.5 groups by `category_name`. A workspace keeps
// the views its install wrote, and the update pass (bundle-updates.ts) leaves
// an install whose update reports a conflict for the person's prompt, so such
// a workspace kept a pinned view that could not group (#5624 opens it
// ungrouped, with a note) for as long as nobody pressed update.
//
// So a bundle-seeded view whose grouping, sort or filter names a field its
// kind does not have takes the shipped bundle's current definition of that
// view, only when the view still holds exactly what the install shipped: a
// person's edit is theirs. The install's stored manifest learns the healed
// definition, so the next boot finds nothing to compare and opens no tenant
// pool. A workspace whose installs match the catalog costs one meta read.

import { sql, type Kysely } from "kysely";
import { listFlagshipManifests } from "../lib/flagship-bundles.js";
import { notePassFailure } from "./pass-failures.js";
import { mapManifestViews, planViewHeals, sameConfig, type ViewHeal } from "./heal-bundle-view-fields-plan.js";

/** Fields every record answers to, whatever its kind declares. */
const PLATFORM_FIELDS = ["title", "name", "location", "created_at", "updated_at"];

export async function healBundleViewFields(opts: { onlyOrgId?: string } = {}): Promise<{ healed: number; failed: number }> {
  const { meta } = await import("../db/meta.js");
  const { withTenantDbForSweep } = await import("../db/tenant.js");
  const { listKindsForOrg } = await import("./entities.js");
  const { resolveFieldDefsForKind } = await import("./field-defs.js");
  const catalog = new Map(listFlagshipManifests("all").map((m) => [String(m.id ?? ""), m as unknown]));
  let q = meta.selectFrom("bundles").select(["id", "org_id", "external_id", "manifest", "enabled_features"]).where("install_status", "=", "active");
  if (opts.onlyOrgId) q = q.where("org_id", "=", opts.onlyOrgId);
  const installs = await q.execute();

  let healed = 0;
  let failed = 0;
  for (const b of installs) {
    const shipped = catalog.get(b.external_id);
    if (!shipped) continue;
    const features = b.enabled_features ?? [];
    const was = mapManifestViews(b.manifest, features).views;
    const now = mapManifestViews(shipped, features).views;
    // Meta-only until here: an install whose views ship as they did is done.
    if (!was.some((v) => now.some((n) => n.entity_kind === v.entity_kind && n.name === v.name && !sameConfig(n.config, v.config)))) continue;
    try {
      const kinds = new Map((await listKindsForOrg(b.org_id)).map((k) => [k.id, k.fields.map((f) => f.name)]));
      const fields = new Map<string, Set<string>>();
      for (const kind of new Set(was.map((v) => v.entity_kind))) {
        const own = kinds.get(kind);
        if (!own) continue;
        const defs = await resolveFieldDefsForKind(b.org_id, kind);
        fields.set(kind, new Set([...PLATFORM_FIELDS, ...own, ...defs.map((d) => d.name)]));
      }
      const heals = planViewHeals(was, now, (kind) => fields.get(kind));
      if (!heals.length) continue;
      const settled: ViewHeal[] = [];
      await withTenantDbForSweep(b.org_id, async (db) => {
        const tdb = db as unknown as Kysely<Record<string, never>>;
        for (const h of heals) {
          // Guarded in the write: a view edited since the install keeps its edit.
          const r = await sql`
            update core_views_views set config = ${JSON.stringify(h.config)}::jsonb, updated_at = now()
             where bundle_id = ${b.id} and entity_kind = ${h.entity_kind} and name = ${h.name}
               and config = ${JSON.stringify(h.from)}::jsonb`.execute(tdb);
          healed += Number(r.numAffectedRows ?? 0);
          // Healed, edited or deleted: nothing holds the old definition now.
          const left = await sql<{ n: number }>`
            select count(*)::int as n from core_views_views
             where bundle_id = ${b.id} and entity_kind = ${h.entity_kind} and name = ${h.name}
               and config = ${JSON.stringify(h.from)}::jsonb`.execute(tdb);
          if (!left.rows[0]?.n) settled.push(h);
        }
      });
      if (settled.length) {
        const next = mapManifestViews(b.manifest, features, (v) => settled.find((h) => h.entity_kind === v.entity_kind && h.name === v.name && sameConfig(h.from, v.config))?.config).manifest;
        // SHAPE-UNCHANGED: the stored copy of what the install shipped; no menu, collection or module moves
        await meta.updateTable("bundles").set({ manifest: sql`${JSON.stringify(next)}::jsonb` as never }).where("id", "=", b.id).execute();
      }
    } catch (err) {
      failed++;
      notePassFailure("healBundleViewFields", b.org_id, err);
      console.error(`[heal-bundle-view-fields] ${b.external_id} in ${b.org_id}:`, (err as Error).message);
    }
  }
  return { healed, failed };
}
