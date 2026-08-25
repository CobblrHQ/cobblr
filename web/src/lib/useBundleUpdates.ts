// Detects installed bundles that have a newer version in the catalog, so the
// "update available" signal can surface OUTSIDE the marketplace page (the author: "I
// had to go hunting into bundles to find the update existed"). Used by the
// dashboard banner + the nav badge. Single source of truth for the comparison
// (was previously inlined only in BundlesPage).

import { useQuery } from "@tanstack/react-query";
import { isDowngradeOrSame } from "./bundleUpdateTier";
import { api, type PlatformBundleManifest } from "./api";
import { useBundleCatalog } from "./useBundleCatalog";

const SOURCES_KEY = "cobblr.registry.sources";

function loadSources(): string[] | undefined {
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(list) && list.length ? list : undefined;
  } catch {
    return undefined;
  }
}

export interface BundleUpdate {
  externalId: string;
  name: string;
  glyph: string;
  installedV: string;
  latestV: string;
  /** Catalog manifest for the new version — what an inline "Update Now" installs. */
  manifest: PlatformBundleManifest;
  /** Manifest of the version CURRENTLY installed. Needed to detect a catalog
   *  DROP (the installed version shipped a catalog the new one removed) — a
   *  data-loss case the new manifest alone can't reveal. Undefined for old
   *  install rows without a stored manifest → callers must treat that as unsafe. */
  installedManifest: PlatformBundleManifest | undefined;
  /** Features enabled on the CURRENT install — replayed on an inline update so a
   *  one-click update never silently re-enables defaults the user turned off. */
  enabledFeatures: string[];
}

/** Installed bundles whose catalog version differs from what's installed. */
export function useBundleUpdates(slug: string): BundleUpdate[] {
  const installed = useQuery({
    queryKey: ["bundles", slug],
    queryFn: () => api.listBundles(slug),
    enabled: !!slug,
  });
  const { catalog } = useBundleCatalog(loadSources());
  if (!installed.data) return [];

  const latestById = new Map(catalog.map((c) => [c.manifest.id, c]));
  const updates: BundleUpdate[] = [];
  for (const b of installed.data.items) {
    const cat = latestById.get(b.external_id);
    // "Differs" is not "newer": during a registry lag the catalog can be BEHIND
    // a freshly-installed version, and offering that as an update invites a
    // hand-confirmed downgrade. Proven-backward (or equal) catalog versions are
    // not updates; unparseable ones keep the old behaviour.
    if (cat && cat.manifest.version && cat.manifest.version !== b.version && !isDowngradeOrSame(b.version, cat.manifest.version)) {
      updates.push({
        externalId: b.external_id,
        name: cat.manifest.name ?? b.name,
        glyph: cat.glyph ?? "📦",
        installedV: b.version,
        latestV: cat.manifest.version,
        manifest: cat.manifest,
        installedManifest: b.manifest,
        enabledFeatures: b.enabled_features ?? [],
      });
    }
  }
  return updates;
}
