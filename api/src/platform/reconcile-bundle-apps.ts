// PERMANENT RECONCILE. A bundle can record its new version while an unchanged
// installed app still runs an older default. Stored snapshots identify that
// default; edits and deleted apps are left with their person.
// BORN WITH: syncBundleApps (bundle installation creates or updates its default apps)
import { sql, type Kysely } from "kysely";
import { appsFromManifest, syncBundleApps, type BundleAppsDB } from "../routes/bundle-apps.js";
import { resolveAppViewRefs } from "../routes/bundle-app-view-refs.js";
import { registerTenantSweep, runTenantSweep } from "./tenant-sweeps.js";
import { withWorkspaceLock } from "./workspace-lock.js";

const PASS = "kernel.bundle-apps";
const HAS_APPS = sql<boolean>`coalesce(manifest->'provides_apps', '[]'::jsonb) <> '[]'::jsonb
  or jsonb_path_exists(manifest, '$.features[*].provides_apps[*]')`;
type AppDb = BundleAppsDB & { core_views_views: { id: string; name: string; entity_kind: string; bundle_id: string | null } };

export async function reconcileBundleApps(): Promise<{ updated: number; failed: number }> {
  registerTenantSweep({
    name: PASS,
    everyMs: 60 * 60 * 1000,
    candidates: async (orgIds) => {
      if (!orgIds.length) return [];
      const { meta } = await import("../db/meta.js");
      const installs = await meta.selectFrom("bundles").select(["org_id", "manifest", "enabled_features"])
        .where("install_status", "=", "active").where("org_id", "in", orgIds).where(HAS_APPS).execute();
      return [...new Set(installs.filter((b) => appsFromManifest(b.manifest, b.enabled_features ?? []).length > 0).map((b) => b.org_id))];
    },
    visit: async ({ orgId, db }) => withWorkspaceLock(orgId, "bundle-apply", async () => {
      const { meta } = await import("../db/meta.js");
      const bundles = await meta.selectFrom("bundles").select(["id", "external_id", "manifest", "enabled_features"])
        .where("org_id", "=", orgId).where("install_status", "=", "active").where(HAS_APPS).execute();
      const tdb = db as unknown as Kysely<AppDb>;
      let updated = 0;
      for (const bundle of bundles) {
        const apps = appsFromManifest(bundle.manifest, bundle.enabled_features ?? []);
        if (!apps.length) continue;
        const views = await tdb.selectFrom("core_views_views").select(["id", "name", "entity_kind"])
          .where("bundle_id", "=", bundle.id).execute();
        const history = await meta.selectFrom("bundle_snapshots").select(["manifest", "enabled_features"])
          .where("org_id", "=", orgId).where("external_id", "=", bundle.external_id).execute();
        const defaults = [...history, bundle].flatMap((b) => appsFromManifest(b.manifest, b.enabled_features ?? []))
          .flatMap((app) => {
            const resolved = resolveAppViewRefs(app.pages, views);
            return resolved.unresolved.length ? [] : [{ ...app, pages: resolved.pages }];
          });
        updated += await syncBundleApps(tdb as unknown as Kysely<BundleAppsDB>, apps, defaults, views, false);
      }
      return { updated };
    }),
  });
  const result = await runTenantSweep(PASS);
  return { updated: result.results.reduce((sum, visit) => sum + Number((visit.result as { updated?: number } | undefined)?.updated ?? 0), 0), failed: result.failed };
}
