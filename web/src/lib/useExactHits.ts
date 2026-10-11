// What a typed value exactly IS: a serial, a code, a token, answered by the
// resolvable registry (POST /resolve) the scanner uses. One reader for every
// door a person searches from (the palette, the header bar, the search page),
// so an exact identifier is found the same way from each; only the palette
// used to ask, and a serial typed into the header bar found nothing by name.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { mayRead } from "./acting-role";
import { useKindLabels } from "./useKindLabels";

export function useExactHits(slug: string | null | undefined, value: string, surface: "palette" | "search", enabled = true) {
  const v = value.trim();
  const canResolve = !!slug && mayRead(`/orgs/${slug}/resolve`);
  const q = useQuery({
    queryKey: ["resolve", surface, slug, v],
    queryFn: () => api.resolveOnSurface(slug!, v, surface),
    enabled: enabled && canResolve && v.length >= 2,
    staleTime: 15_000,
  });
  const labels = useKindLabels(slug);
  const d = canResolve ? q.data : undefined;
  // Stable between renders, so a list built from it is not rebuilt each time.
  // `where` is what a person reads under the name: the provider's own line,
  // or the collection's name, never the raw kind id ("inventory:part").
  return useMemo(() => {
    const cs = d?.outcome === "resolved" ? [d.candidate] : d?.outcome === "ambiguous" ? d.candidates : [];
    return cs.map((c) => ({ ...c, where: c.sublabel && c.sublabel !== c.entity_kind ? c.sublabel : labels.collection(c.entity_kind) }));
  }, [d, labels]);
}
