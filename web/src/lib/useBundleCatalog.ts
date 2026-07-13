// Shared marketplace-catalog hook. The bundle catalog is registry-backed
// (GET /registry/index merges the official cobblr-extensions index with any
// third-party sources); the embedded FEATURED_BUNDLES is the offline fallback.
//
// The registry index intentionally carries only the manifest + card metadata —
// it drops `next_steps`, which is web-only post-install nav guidance, not part
// of the installable manifest. So a flagship bundle loaded from the registry
// would lose its "Add your first yarn" landing step. This hook restores
// next_steps (and glyph as a backstop) by matching the registry entry to the
// embedded flagship catalog by manifest id — in ONE place, so both the
// marketplace page and the first-run wizard get correct landings.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, type RegistryIndex } from "./api";
import { FEATURED_BUNDLES, type FeaturedBundle } from "./featured-bundles";

export type CatalogBundle = FeaturedBundle & { source?: string };

const EMBEDDED_BY_ID = new Map(FEATURED_BUNDLES.map((b) => [b.manifest.id, b]));

export function useBundleCatalog(sources?: string[]): {
  registry: UseQueryResult<RegistryIndex>;
  catalog: CatalogBundle[];
} {
  const registry = useQuery({
    queryKey: ["registry-index", sources ?? []],
    queryFn: () => api.getRegistryIndex(sources),
  });

  const catalog: CatalogBundle[] =
    registry.data && registry.data.bundles.length > 0
      ? registry.data.bundles.map((e) => {
          const embedded = EMBEDDED_BY_ID.get(e.manifest.id);
          return {
            manifest: e.manifest,
            // Prefer the EMBEDDED flagship glyph over the registry entry's: the
            // official index carries no real glyph (it is a web-only card field),
            // so an index placeholder must never win over the authoritative one.
            // A third-party bundle (not in EMBEDDED_BY_ID) still uses its own
            // e.glyph. Fixes every flagship card showing a box (2026-07-13).
            glyph: embedded?.glyph ?? e.glyph ?? "📦",
            blurb: e.blurb ?? e.description ?? embedded?.blurb ?? "",
            // next_steps + item_example are web-only metadata the registry
            // drops; restore them from the embedded flagship catalog so the
            // post-install landing AND the "add your first <thing>" prompt
            // (WhatToDoPanel) survive for registry-loaded bundles.
            next_steps: embedded?.next_steps,
            item_example: embedded?.item_example,
            source: e.source,
          };
        })
      : FEATURED_BUNDLES;

  return { registry, catalog };
}
