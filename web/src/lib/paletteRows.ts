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

export type PaletteRowKind = "exact" | "entity" | "inbox" | "files" | "file" | "app" | "table" | "feature" | "action";

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

/** The sections, in the order a search reads them (#3823): your things (an
 *  exact identifier hit leading them), what is waiting in the scan inbox, the
 *  files (behind one "Files (N)" row), then pages & settings and the commands.
 *  Files used to be "your things", so a photo named after a printer ranked
 *  above the printer. Exported so the caller and the test share one order. */
export const PALETTE_RANK = {
  exact: 90,
  entity: 80,
  inbox: 70,
  files: 60,
  file: 59,
  // Every module by name, on, hidden or off (#3883): above a settings page
  // that happens to share its route, which it dedupes (the app wins).
  app: 56,
  table: 55,
  feature: 50,
  action: 45,
} as const;

/** A table the person has, found by what it is called or by any other word
 *  it offers: a Supplies table answers to "notions" too, and says so. */
export interface PaletteTable {
  label: string;
  route: string;
  otherNames: readonly string[];
}

export function tablesMatching(q: string, tables: readonly PaletteTable[]): Array<{ label: string; route: string; hint: string }> {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: Array<{ label: string; route: string; hint: string }> = [];
  for (const t of tables) {
    if (t.label.toLowerCase().includes(needle)) out.push({ label: t.label, route: t.route, hint: "your table" });
    else {
      const via = t.otherNames.find((n) => n.toLowerCase().includes(needle));
      if (via) out.push({ label: t.label, route: t.route, hint: `also called ${via}` });
    }
  }
  return out.slice(0, 4);
}

/** A search hit that is an uploaded file rather than a thing you keep. Files
 *  are found by search too, in their own section, never among your things. */
export const FILE_HIT_KIND = "core-files:file";
export function isFileHit(hit: { kind: string }): boolean {
  return hit.kind === FILE_HIT_KIND;
}

/** The heading over a row, when its section starts there. Commands carry
 *  none on the empty palette (they are the whole list), and share "pages &
 *  settings" once a search is typed. */
export function paletteSectionHeader(row: PaletteRow, prev: PaletteRow | undefined, searching: boolean): string | null {
  const heading = (k: PaletteRowKind): string | null =>
    k === "exact" ? "best match"
      : k === "entity" ? "your things"
      : k === "inbox" ? "waiting in the scan inbox"
      : k === "app" ? "apps"
      : k === "table" ? "your tables"
      : k === "feature" || k === "action" ? (searching || k === "feature" ? "pages & settings" : null)
      : null;
  const h = heading(row.kind);
  if (!h) return null;
  return prev && heading(prev.kind) === h ? null : h;
}

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
