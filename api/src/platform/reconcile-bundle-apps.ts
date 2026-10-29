// PERMANENT RECONCILE. A bundle can record its new version while an unchanged
// installed app still runs an older default. Stored snapshots identify that
// default; edits and deleted apps are left with their person.
// BORN WITH: syncBundleApps (bundle installation creates or updates its default apps)
//
// A workspace whose app bundles and their snapshots have not changed since
// its last clean visit is not visited: its fingerprint, with the version of
// this code, is its mark in boot_sweep_marks. The boot visits only changed
// workspaces; the hourly rounds also revisit one whose mark is a week old.
// Every boot used to visit every workspace with app bundles before listen:
// 6 s to 38 s on staging in three days as workspaces grew (#8918).
import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { appsFromManifest, syncBundleApps, type BundleAppsDB } from "../routes/bundle-apps.js";
import { resolveAppViewRefs } from "../routes/bundle-app-view-refs.js";
import { registerTenantSweep, runTenantSweep } from "./tenant-sweeps.js";
import { withWorkspaceLock } from "./workspace-lock.js";
import { markSwept, sweepVersion } from "./boot-sweep-marks.js";

const PASS = "kernel.bundle-apps";
const HAS_APPS = sql<boolean>`coalesce(manifest->'provides_apps', '[]'::jsonb) <> '[]'::jsonb
  or jsonb_path_exists(manifest, '$.features[*].provides_apps[*]')`;
type AppDb = BundleAppsDB & { core_views_views: { id: string; name: string; entity_kind: string; bundle_id: string | null } };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const markOf = (orgId: string) => `${PASS}/${orgId}`;
const CODE = sweepVersion(registerBundleAppsPass, syncBundleApps, appsFromManifest, resolveAppViewRefs);

let booting = false;
const fingerprints = new Map<string, string>();

/** The workspaces with app bundles worth visiting: a changed fingerprint, no
 *  mark, a named run, or (outside the boot) a mark a week old. */
export async function bundleAppsDue(orgIds: string[], opts: { named: boolean; atBoot: boolean; now?: Date }): Promise<string[]> {
  if (!orgIds.length) return [];
  const { meta } = await import("../db/meta.js");
  const installs = await meta.selectFrom("bundles").select(["id", "org_id", "external_id", "version", "manifest", "enabled_features"])
    .where("install_status", "=", "active").where("org_id", "in", orgIds).where(HAS_APPS).execute();
  const byOrg = new Map<string, string[]>();
  const externals = new Set<string>();
  for (const b of installs) {
    const apps = appsFromManifest(b.manifest, b.enabled_features ?? []);
    if (!apps.length) continue;
    externals.add(b.external_id);
    const parts = byOrg.get(b.org_id) ?? [];
    parts.push(`${b.id}|${b.external_id}|${b.version}|${JSON.stringify(apps)}`);
    byOrg.set(b.org_id, parts);
  }
  if (!byOrg.size) return [];
  const orgs = [...byOrg.keys()];
  const snapshots = await meta.selectFrom("bundle_snapshots").select(["org_id", "id"])
    .where("org_id", "in", orgs).where("external_id", "in", [...externals]).execute();
  for (const snap of snapshots) byOrg.get(snap.org_id)?.push(`snapshot|${snap.id}`);
  const marks = await meta.selectFrom("boot_sweep_marks").select(["pass", "version", "swept_at"])
    .where("pass", "in", orgs.map(markOf)).execute();
  const markBy = new Map(marks.map((m) => [m.pass, m]));
  const now = (opts.now ?? new Date()).getTime();
  const due: string[] = [];
  for (const orgId of orgs) {
    const fp = createHash("sha256").update(CODE).update("\0").update(byOrg.get(orgId)!.sort().join("\n")).digest("hex").slice(0, 16);
    fingerprints.set(orgId, fp);
    const mark = markBy.get(markOf(orgId));
    const stale = mark ? now - new Date(mark.swept_at).getTime() >= WEEK_MS : true;
    if (opts.named || !mark || mark.version !== fp || (stale && !opts.atBoot)) due.push(orgId);
  }
  return due;
}

export async function reconcileBundleApps(): Promise<{ updated: number; failed: number }> {
  registerBundleAppsPass();
  booting = true;
  let result;
  try {
    result = await runTenantSweep(PASS);
  } finally {
    booting = false;
  }
  return { updated: result.results.reduce((sum, visit) => sum + Number((visit.result as { updated?: number } | undefined)?.updated ?? 0), 0), failed: result.failed };
}

export function registerBundleAppsPass(): void {
  registerTenantSweep({
    name: PASS,
    everyMs: 60 * 60 * 1000,
    candidates: (orgIds, { named }) => bundleAppsDue(orgIds, { named, atBoot: booting }),
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
      const fp = fingerprints.get(orgId);
      if (fp) await markSwept(markOf(orgId), fp, 0);
      return { updated };
    }),
  });
}

