// The command palette's result merge, as a pure function so ordering + dedupe
// are testable without a DOM (same discipline as barcode-wedge / scanResolveAction).
//
// The palette used to decide precedence with index arithmetic
// (`actions.length + featureHits.length + entityHits.length`), which was fragile
// and made ordering impossible to state. Now each source contributes rows with a
// RANK, and this merges them by rank, deduping an entity that appears both as an
// exact identifier hit and as a fuzzy text hit. See
// docs/design-decisions/resolvable-registry.md (the palette is the client half).

import type { LucideIcon } from "lucide-react";

export type PaletteRowKind = "exact" | "action" | "feature" | "entity";

export interface PaletteRow {
  /** React key, unique across the merged list. */
  key: string;
  kind: PaletteRowKind;
  label: string;
  hint?: string;
  icon: LucideIcon;
  /** A zero-arg thunk closing over navigate / the target, so the merge stays
   *  opaque to how a row acts. */
  run: () => void;
  /** Entities carry `kind:id` here; a fuzzy row is dropped when an exact row for
   *  the same entity already won. Rows without a key never dedupe. */
  dedupeKey?: string;
}

/** Suggested ranks (resolvable-registry.md 3.3): an exact identifier hit leads,
 *  then commands, then features, then fuzzy text. Exported so the caller and the
 *  test share one source of truth. */
export const PALETTE_RANK = {
  exact: 90,
  action: 60,
  feature: 50,
  entity: 40,
} as const;

/** Merge ranked groups into one list, highest rank first, deduped by dedupeKey.
 *
 *  Array.prototype.sort is stable, so rows of equal rank keep the order the
 *  caller supplied them in (and a group's internal order is preserved). The first
 *  row seen for a dedupeKey wins, which is the higher-ranked one because we sort
 *  before deduping. */
export function mergePaletteRows(groups: { rank: number; rows: PaletteRow[] }[]): PaletteRow[] {
  const ranked = groups.flatMap((g) => g.rows.map((r) => ({ r, rank: g.rank })));
  ranked.sort((a, b) => b.rank - a.rank);
  const seen = new Set<string>();
  const out: PaletteRow[] = [];
  for (const { r } of ranked) {
    if (r.dedupeKey) {
      if (seen.has(r.dedupeKey)) continue;
      seen.add(r.dedupeKey);
    }
    out.push(r);
  }
  return out;
}
