// The ONE generic resolver that replaces the per-vendor maker-scan module. It
// consults a manifest list — built-in (shipped data) + operator-added (the global
// `scan_url_resolvers` table) — and interprets whichever claims the scanned value.
// Registered once at boot through the existing platform().scan seam.

import { platform } from "@cobblr/platform-contract";
import type { ScanUrlResolution } from "@cobblr/platform-contract";
import { meta } from "../../db/meta.js";
import { BUILTIN_SCAN_URL_RESOLVERS } from "./builtins.js";
import { matchesManifest, runManifest, type RunDeps } from "./interpret.js";
import { ScanUrlResolverManifest } from "./types.js";

/** The list the generic resolver consults. Refreshed at boot + after a CRUD
 *  write. Operator rows override a built-in with the same id (so an operator can
 *  edit or disable Polar), otherwise built-ins fill in. */
let manifests: ScanUrlResolverManifest[] = [...BUILTIN_SCAN_URL_RESOLVERS];

export function getScanUrlManifests(): ScanUrlResolverManifest[] {
  return manifests;
}

export async function refreshScanUrlManifests(): Promise<void> {
  let operatorRows: ScanUrlResolverManifest[] = [];
  try {
    const rows = await meta.selectFrom("scan_url_resolvers").select(["manifest"]).orderBy("position").execute();
    operatorRows = rows
      .map((r) => ScanUrlResolverManifest.safeParse(r.manifest))
      .filter((p): p is { success: true; data: ScanUrlResolverManifest } => p.success)
      .map((p) => p.data);
  } catch (err) {
    // Table may not exist yet (pre-migration) — fall back to built-ins only.
    console.error("[scan-url-resolvers] could not load operator rows:", (err as Error).message);
  }
  const overridden = new Set(operatorRows.map((m) => m.id));
  manifests = [...operatorRows, ...BUILTIN_SCAN_URL_RESOLVERS.filter((m) => !overridden.has(m.id))];
}

const deps: RunDeps = {
  fetch: (input, init) => fetch(input as string, init),
  cacheGet: (ns, key) => platform().sharedCache.get<ScanUrlResolution>(ns, key),
  cachePut: (ns, key, val) => platform().sharedCache.put(ns, key, val),
};

let registered = false;
/** Register the single generic vendor resolver. Idempotent; called once at boot. */
export function registerDeclarativeScanResolver(): void {
  if (registered) return;
  registered = true;
  platform().scan.registerUrlResolver({
    name: "declarative-vendor-resolvers",
    matches: (value) => manifests.some((m) => matchesManifest(m, value)),
    resolve: async (value, opts) => {
      for (const m of manifests) {
        if (!matchesManifest(m, value)) continue;
        const r = await runManifest(m, value, opts, deps).catch(() => null);
        if (r) return r;
      }
      return null;
    },
  });
}
