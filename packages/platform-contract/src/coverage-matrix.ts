// The test coverage matrix (#4286): every surface the platform has, against
// every way it should be tested, and what the newest walk of each pair said.
//
// One contract for both sides. The writers (the attest CLI, the nightly
// walk, the CI role tests) and the reader (the operator console's matrix
// page) import these types and this one rule, so "stale" and "never tested"
// cannot come to mean two different things on the two sides.
//
// A cell absent from `cells` is never tested. Nothing infers it from
// anything else: a surface nobody has walked must read as a gap, not as a
// pass by default.

export const STALE_AFTER_DAYS = 7;

export type CoverageResult = "pass" | "fail" | "na";

/** What a reader shows for one surface × dimension. */
export type CellState = "pass" | "fail" | "na" | "stale" | "never";

export type SurfaceKind = "route" | "entity-list" | "entity-detail" | "action" | "write" | "module-page";

export interface CoverageDimension {
  /** e.g. "390-light", "owner", "api-parity". */
  id: string;
  label: string;
}

export interface CoverageSurface {
  /** e.g. "route:/locations". */
  id: string;
  kind: SurfaceKind;
  label: string;
  module: string | null;
  /** The fundamentals audit area it belongs to, when it has one. */
  area: string | null;
  /** In the navigation, or on a fresh workspace's first run: these rank first. */
  nav: boolean;
  first_run: boolean;
  /** The registry that produced the row, e.g. "ui-reach:web/src/App.tsx".
   *  A row with none is not traced to the platform and says so. */
  source: string | null;
  /** The dimensions that apply to it; absent means all of them. */
  applicable?: string[];
  /** A page's route pattern, when the row is a page. */
  path?: string;
}

export interface CoverageCell {
  surface: string;
  dimension: string;
  result: CoverageResult;
  /** "nightly", or the session that walked it. */
  by: string;
  at: string;
  commit: string;
  /** A screenshot or run log. */
  evidence: string | null;
  /** The CI or nightly run number, when a run wrote it. */
  run?: number | null;
  note?: string;
}

export interface CoverageMatrix {
  generated_at: string;
  /** The commit the rows were generated on: a surface added after it is
   *  not in the matrix yet. */
  commit?: string;
  dimensions: CoverageDimension[];
  surfaces: CoverageSurface[];
  /** The newest cell per surface × dimension, and only that one. */
  cells: CoverageCell[];
  /** Covered pairs per night, so the percentage can be watched going up. */
  history?: Array<{ night: string; covered: number; total: number }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a pair reads as at `now`.
 *  - No cell: never tested.
 *  - A failure stays a failure however old it is. Ageing it into "stale"
 *    would hide a known break behind a softer word until someone walked it.
 *  - Not applicable does not age: nothing is owed there.
 *  - A pass older than STALE_AFTER_DAYS is stale; so is a cell whose time
 *    cannot be read, since an undated pass proves nothing. */
export function cellState(cell: CoverageCell | undefined | null, now: Date | number = Date.now()): CellState {
  if (!cell) return "never";
  if (cell.result === "fail") return "fail";
  if (cell.result === "na") return "na";
  const at = Date.parse(cell.at);
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(at) || nowMs - at > STALE_AFTER_DAYS * DAY_MS) return "stale";
  return "pass";
}

/** The dimensions a surface is walked in. */
export function applicableDimensions(surface: CoverageSurface, dimensions: CoverageDimension[]): CoverageDimension[] {
  if (!surface.applicable) return dimensions;
  const on = new Set(surface.applicable);
  return dimensions.filter((d) => on.has(d.id));
}

/** The newest cell per pair, keyed `${surface}\u0000${dimension}`. A writer
 *  that sends more than one per pair still reads as its newest. */
export function cellIndex(cells: CoverageCell[]): Map<string, CoverageCell> {
  const m = new Map<string, CoverageCell>();
  for (const c of cells) {
    const k = cellKey(c.surface, c.dimension);
    const prev = m.get(k);
    if (!prev || Date.parse(c.at) > Date.parse(prev.at)) m.set(k, c);
  }
  return m;
}

export const cellKey = (surface: string, dimension: string): string => `${surface}\u0000${dimension}`;
