// Per-location external-reference counts — how many machines / assets / parts
// point at each location. Shared by the Locations tree (usage chips, delete
// confirms) and the floor plan's heat view. One probe per location-bearing
// module; query keys match the originals so the caches dedupe.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface UsageCounts {
  machines: number;
  assets: number;
  parts: number;
}

export function emptyCounts(): UsageCounts {
  return { machines: 0, assets: 0, parts: 0 };
}

export function totalUsage(c: UsageCounts | undefined): number {
  if (!c) return 0;
  return c.machines + c.assets + c.parts;
}

export function useLocationUsage(slug: string): Map<string, UsageCounts> {
  const machinesQ = useQuery({
    queryKey: ["machines-for-locations", slug],
    queryFn: () => api.listMachines(slug),
    enabled: !!slug,
  });
  const assetsQ = useQuery({
    queryKey: ["assets-for-locations", slug],
    queryFn: () => api.listAssets(slug),
    enabled: !!slug,
  });
  const partsQ = useQuery({
    queryKey: ["parts-for-locations", slug],
    queryFn: () => api.listInventoryParts(slug),
    enabled: !!slug,
  });
  return useMemo(() => {
    const m = new Map<string, UsageCounts>();
    const bump = (locId: string | null | undefined, key: keyof UsageCounts) => {
      if (!locId) return;
      const c = m.get(locId) ?? emptyCounts();
      c[key]++;
      m.set(locId, c);
    };
    for (const x of machinesQ.data?.items ?? []) bump(x.location_id, "machines");
    for (const x of assetsQ.data?.items ?? []) bump(x.location_id, "assets");
    for (const x of partsQ.data?.items ?? []) bump(x.location_id, "parts");
    return m;
  }, [machinesQ.data, assetsQ.data, partsQ.data]);
}
