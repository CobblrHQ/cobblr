// The words a surface uses for a kind: the collection's name and its item
// noun, from the workspace's own instances. One hook so a chip, a bin sheet
// and an activity row all say "Bookshelf" and "book" for `bookshelf:item`
// rather than each reaching for the id (the 2026-09-12 review saw
// `bookshelf:item`, INVENTORY:PART and "only part in this bin" on three
// surfaces for one book). Shares App's ["instances", slug] cache key, so it
// costs no extra fetch.
import { useQuery } from "@tanstack/react-query";
import { collectionLabelFor, itemNounForKind, viewTypeLabel } from "@cobblr/platform-contract/kind-label";
import { api } from "./api";

export function useKindLabels(slug: string | null | undefined) {
  const q = useQuery({
    queryKey: ["instances", slug],
    queryFn: () => api.listInstances(slug!),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const instances = q.data?.items ?? [];
  return {
    /** "Bookshelf" for bookshelf:item, "Part" for inventory:part. */
    collection: (kind: string | null | undefined) => collectionLabelFor(kind, instances),
    /** "book" for bookshelf:item, "part" for inventory:part. */
    noun: (kind: string | null | undefined) => itemNounForKind(kind, instances),
    /** "Gallery", "Cards", "Board". */
    viewType: viewTypeLabel,
    /** The instance for an instance kind, when a caller needs more than words. */
    instances,
  };
}
