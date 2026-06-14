// useUnits — fetch the workspace's unit vocabulary once (built-in + custom
// + display mode) and hand back the merged list plus bound formatters. The
// catalog is small and changes rarely, so it's cached for a minute.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import type { PlatformUnitDef, UnitDisplayMode } from "./types";
import { convertQuantity, formatQuantity, formatUnit, resolveUnit } from "./units";

export interface UseUnits {
  /** built-in ∪ custom, deduped (custom wins on code collision) */
  all: PlatformUnitDef[];
  builtins: PlatformUnitDef[];
  custom: PlatformUnitDef[];
  displayMode: UnitDisplayMode;
  loading: boolean;
  /** render qty + unit per the workspace display mode */
  format: (qty: number | null | undefined, raw: string | null | undefined) => string;
  /** render just the unit token per the workspace display mode */
  unit: (raw: string | null | undefined) => string;
  resolve: (raw: string | null | undefined) => PlatformUnitDef | null;
  /** convert a value between units (same category, both with a factor), else
   *  null — e.g. 1000 "g" → "kg" = 1 */
  convert: (value: number, fromRaw: string | null | undefined, toRaw: string | null | undefined) => number | null;
}

export function useUnits(): UseUnits {
  const { api, orgSlug } = usePlatformWeb();
  const q = useQuery({
    queryKey: ["core-units", orgSlug],
    queryFn: () => api.listUnits!(orgSlug),
    enabled: !!orgSlug && typeof api.listUnits === "function",
    staleTime: 60_000,
  });

  return useMemo(() => {
    const builtins = q.data?.builtins ?? [];
    const custom = q.data?.custom ?? [];
    const displayMode = q.data?.display_mode ?? "symbol";
    const byCode = new Map<string, PlatformUnitDef>();
    for (const u of builtins) byCode.set(u.code, u);
    for (const u of custom) byCode.set(u.code, u); // custom overrides
    const all = [...byCode.values()];
    return {
      all,
      builtins,
      custom,
      displayMode,
      loading: q.isLoading,
      format: (qty, raw) => formatQuantity(qty, raw, all, displayMode),
      unit: (raw) => formatUnit(raw, all, displayMode),
      resolve: (raw) => resolveUnit(raw, all),
      convert: (value, fromRaw, toRaw) => convertQuantity(value, fromRaw, toRaw, all),
    };
  }, [q.data, q.isLoading]);
}
