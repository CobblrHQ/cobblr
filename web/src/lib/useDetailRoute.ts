// kind → detail-route resolver, fed by the entity-kinds registry (the same
// source SearchBar uses) — so ANY registered kind, including instance items
// ("3d-printers:item"), resolves to its detail page without a per-module
// if-chain. Returns null for kinds with no detail surface; callers render a
// plain (non-link) row in that case.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useDetailRoute(slug: string): (kind: string, id: string) => string | null {
  const kinds = useQuery({
    queryKey: ["entity-kinds", slug],
    queryFn: () => api.listEntityKinds(slug),
    enabled: !!slug,
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const byKind = new Map<string, string | null>();
    for (const k of kinds.data?.items ?? []) byKind.set(k.id, k.detail_route);
    return (kind: string, id: string) => {
      const tmpl = byKind.get(kind);
      return tmpl ? tmpl.replace("{id}", id) : null;
    };
  }, [kinds.data]);
}
