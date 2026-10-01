// Which modules are on in a workspace: null until the list has loaded. A read
// of a module's own routes waits on this, because a module that is off answers
// 409 module_not_enabled, and a page that asks anyway logs an error on every
// load for every workspace that never turned it on. Shares the cached
// ["org-modules"] query the nav already fetches.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export function useEnabledModules(slug: string): Set<string> | null {
  const q = useQuery({
    queryKey: ["org-modules", slug],
    queryFn: () => api.orgModules(slug),
    enabled: !!slug,
    staleTime: 30_000,
  });
  return useMemo(() => (q.data ? new Set(q.data.items.filter((m) => m.enabled).map((m) => m.name)) : null), [q.data]);
}
