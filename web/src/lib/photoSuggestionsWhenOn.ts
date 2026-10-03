// The photo suggestions a list's cards show, asked only of a workspace with
// core-scan on (#4673). A module that is off answers its doors with an error,
// and a page then has nothing to suggest, not something wrong: a fresh
// workspace's machines, assets and project pages each logged the error on
// every load. Reads the same cached ["org-modules"] list the nav fetches.
import type { QueryClient } from "@tanstack/react-query";
import { api, type PhotoSuggestion } from "./api";

export async function photoSuggestionsWhenOn(qc: QueryClient, slug: string, kind: string | null, ids?: string[]): Promise<{ items: PhotoSuggestion[] }> {
  const mods = await qc.fetchQuery({ queryKey: ["org-modules", slug], queryFn: () => api.orgModules(slug), staleTime: 30_000 });
  if (!mods.items.some((m) => m.name === "core-scan" && m.enabled)) return { items: [] };
  return api.photoSuggestions(slug, kind, ids);
}
