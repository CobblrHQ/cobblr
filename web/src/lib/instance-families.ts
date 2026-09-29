// Which collections are a type collection and the collection of its things
// (Filament Types → Spools), read from each instance's config the way the
// page reads it: a child names its parent. The dashboard folds each pair into
// one tile and keeps their view cards off, so the pair never shows as two.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface InstanceFamily {
  child: string;
  /** The pair's shared nav-group label ("Filament"), or "" when it has none. */
  label: string;
}

/** type collection → its family. */
export function useInstanceFamilies(slug: string): Map<string, InstanceFamily> {
  const q = useQuery({
    queryKey: ["entity-kind-overrides", slug],
    queryFn: () => api.listOverrides(slug),
    enabled: !!slug,
    staleTime: 60_000,
  });
  return useMemo(() => {
    const out = new Map<string, InstanceFamily>();
    const rows = (q.data?.items ?? []).filter((o) => o.target_kind === "instance");
    const cfgOf = (inst: string) => rows.find((o) => o.target_id.endsWith(`:${inst}`))?.config as { nav_group?: { label?: string } } | undefined;
    for (const o of rows) {
      const child = o.target_id.split(":")[1];
      const parent = (o.config as { parent?: { instance?: string } } | undefined)?.parent?.instance;
      if (child && parent) out.set(parent, { child, label: cfgOf(parent)?.nav_group?.label ?? "" });
    }
    return out;
  }, [q.data]);
}

/** Both halves of every pair, as the nav/kind names ("filament-types", "filament"). */
export function foldedNames(families: ReadonlyMap<string, InstanceFamily>): Set<string> {
  return new Set([...families].flatMap(([parent, f]) => [parent, f.child]));
}
