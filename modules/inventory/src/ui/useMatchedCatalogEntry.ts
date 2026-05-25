// Look up the first `matches → core-catalogs:entry` pairing for a
// given part. Used by PartDetailPage (and PartsTable in v0.3) to
// render the "matched in X" chip and hydrate blank fields from the
// catalog entry's payload.
//
// Goes through the platform's generic walkPairings endpoint, which
// already projects ResolvedEntity ({ title, subtitle, image_path,
// fields }). The catalog's title_column / image_column / subtitle_column
// have already been applied server-side — the client just renders.

import { useQuery } from "@tanstack/react-query";
import { useInventory } from "./context";

export interface MatchedCatalogEntry {
  kind: string; // "core-catalogs:entry"
  id: string;
  title: string;
  subtitle?: string;
  image_path?: string;
  fields: Record<string, unknown>;
}

export function useMatchedCatalogEntry(partId: string | undefined) {
  const { orgSlug, getToken } = useInventory();
  return useQuery({
    queryKey: ["inventory-part-match", orgSlug, partId],
    enabled: !!partId,
    staleTime: 60_000,
    queryFn: async (): Promise<MatchedCatalogEntry | null> => {
      const token = getToken();
      const res = await fetch(
        `/api/v1/orgs/${orgSlug}/entities/inventory:part/${partId}/pairings?rel=matches&dir=out&kind=core-catalogs:entry`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { items: MatchedCatalogEntry[] };
      return body.items?.[0] ?? null;
    },
  });
}
