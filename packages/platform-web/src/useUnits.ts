// useUnits — fetch the workspace's unit vocabulary once (built-in + custom
// + display mode) and hand back the merged list plus bound formatters. The
// catalog is small and changes rarely, so it's cached for a minute.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import type { CountWords } from "@cobblr/platform-contract/plural";
import type { PlatformUnitDef, UnitDisplayMode } from "./types";
import { convertQuantity, formatQuantity, formatUnit, quantitySuffix, resolveUnit, unitLens } from "./units";

export interface UseUnits {
  /** built-in ∪ custom, deduped (custom wins on code collision) */
  all: PlatformUnitDef[];
  builtins: PlatformUnitDef[];
  custom: PlatformUnitDef[];
  displayMode: UnitDisplayMode;
  loading: boolean;
  /** render qty + unit per the workspace display mode; the word agrees with
   *  the count, using `known` (a table's declared words) for a unit the
   *  vocabulary does not hold */
  format: (qty: number | null | undefined, raw: string | null | undefined, known?: readonly CountWords[]) => string;
  /** just the unit's word as it reads beside `qty` ("hank" / "hanks"); the
   *  symbol for a measured unit */
  wordFor: (qty: number, raw: string | null | undefined, known?: readonly CountWords[]) => string;
  /** render just the unit token per the workspace display mode */
  unit: (raw: string | null | undefined) => string;
  /** the unit to show beside a quantity in a list — the symbol for a measured
   *  unit, "" for a countable one (see quantitySuffix) */
  suffix: (raw: string | null | undefined) => string;
  resolve: (raw: string | null | undefined) => PlatformUnitDef | null;
  /** convert a value between units (same category, both with a factor), else
   *  null — e.g. 1000 "g" → "kg" = 1 */
  convert: (value: number, fromRaw: string | null | undefined, toRaw: string | null | undefined) => number | null;
  /** the vocabulary as a consumption gauge reads it (consumption-gauge.ts) */
  lens: ReturnType<typeof unitLens>;
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
      format: (qty, raw, known) => formatQuantity(qty, raw, all, displayMode, known),
      wordFor: (qty, raw, known) => formatQuantity(qty, raw, all, displayMode, known).replace(/^\S+\s*/, ""),
      unit: (raw) => formatUnit(raw, all, displayMode),
      suffix: (raw) => quantitySuffix(raw, all),
      resolve: (raw) => resolveUnit(raw, all),
      convert: (value, fromRaw, toRaw) => convertQuantity(value, fromRaw, toRaw, all),
      lens: unitLens(all),
    };
  }, [q.data, q.isLoading]);
}
