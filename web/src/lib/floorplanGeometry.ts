// Pure geometry + metadata readers for the location floor plan. Kept free of
// React so the math is unit-testable. All values are integer mm; origin is
// the bound's top-left; x → right, y → down.
// See docs/design-decisions/location-floor-plan.md.

export interface FpOpening {
  at_mm: number;
  w_mm: number;
}

export interface FpWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  openings?: FpOpening[];
}

export interface FpBound {
  w_mm: number;
  d_mm: number;
  unit?: "ft" | "in" | "m" | "cm" | "mm";
  /** "plan" = top-down (room: w × depth); "front" = elevation (toolbox face:
   *  w × height). Same geometry — only labels change. */
  view?: "plan" | "front";
  /** Snap pitch for THIS layout, mm. A garage wants the 100mm default; a
   *  drawer wants 42 (exact Gridfinity) or whatever "1 square" means to its
   *  owner. Placement positions AND sizes quantize to it. */
  grid_mm?: number;
  walls?: FpWall[];
}

export interface FpRect {
  x_mm: number;
  y_mm: number;
  w_mm: number;
  d_mm: number;
  wall_mounted?: boolean;
}

export const SNAP_MM = 100;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** The bound (room dims + walls) off a location's metadata, or null. Reads
 *  defensively — metadata is a free jsonb and may hold anything. */
export function readBound(metadata: Record<string, unknown> | null | undefined): FpBound | null {
  const fp = (metadata?.floorplan ?? null) as Record<string, unknown> | null;
  if (!fp) return null;
  const w = num(fp.w_mm);
  const d = num(fp.d_mm);
  if (!w || !d) return null;
  const walls: FpWall[] = [];
  if (Array.isArray(fp.walls)) {
    for (const raw of fp.walls) {
      const wl = raw as Record<string, unknown>;
      const x1 = num(wl.x1), y1 = num(wl.y1), x2 = num(wl.x2), y2 = num(wl.y2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
      if (x1 !== x2 && y1 !== y2) continue; // axis-aligned only
      const openings: FpOpening[] = [];
      if (Array.isArray(wl.openings)) {
        for (const o of wl.openings) {
          const at = num((o as Record<string, unknown>).at_mm);
          const ow = num((o as Record<string, unknown>).w_mm);
          if (at !== null && ow !== null && ow > 0) openings.push({ at_mm: at, w_mm: ow });
        }
      }
      walls.push({ x1, y1, x2, y2, ...(openings.length ? { openings } : {}) });
    }
  }
  const grid = num(fp.grid_mm);
  return {
    w_mm: w,
    d_mm: d,
    unit: fp.unit === "ft" || fp.unit === "in" || fp.unit === "m" || fp.unit === "cm" || fp.unit === "mm" ? fp.unit : undefined,
    view: fp.view === "front" ? "front" : fp.view === "plan" ? "plan" : undefined,
    ...(grid && grid >= 5 && grid <= 1000 ? { grid_mm: grid } : {}),
    ...(walls.length ? { walls } : {}),
  };
}

/** A child's placement rect off its metadata, or null (unplaced). A blob that
 *  parses as a bound but not a rect is NOT a placement. */
export function readRect(metadata: Record<string, unknown> | null | undefined): FpRect | null {
  const fp = (metadata?.floorplan ?? null) as Record<string, unknown> | null;
  if (!fp) return null;
  const x = num(fp.x_mm), y = num(fp.y_mm), w = num(fp.w_mm), d = num(fp.d_mm);
  if (x === null || y === null || !w || !d) return null;
  return { x_mm: x, y_mm: y, w_mm: w, d_mm: d, wall_mounted: fp.wall_mounted === true };
}

export function snap(v: number, grid: number = SNAP_MM): number {
  return Math.round(v / grid) * grid;
}

/** Keep a rect inside the bound (shrinks before it clips). The minimum cell
 *  is the layout's own grid pitch, so a 42mm Gridfinity drawer allows 42mm
 *  bins while a garage keeps its coarser floor. */
export function clampRect(rect: FpRect, bound: FpBound): FpRect {
  const cell = bound.grid_mm ?? SNAP_MM;
  const w = Math.max(cell, Math.min(rect.w_mm, bound.w_mm));
  const d = Math.max(cell, Math.min(rect.d_mm, bound.d_mm));
  const x = Math.max(0, Math.min(rect.x_mm, bound.w_mm - w));
  const y = Math.max(0, Math.min(rect.y_mm, bound.d_mm - d));
  return { ...rect, x_mm: x, y_mm: y, w_mm: w, d_mm: d };
}

/** A wall drawn minus its door openings: the visible sub-segments, in order.
 *  Openings are clamped to the segment and merged when overlapping. */
export function wallSegments(wall: FpWall): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const vertical = wall.x1 === wall.x2;
  const start = vertical ? Math.min(wall.y1, wall.y2) : Math.min(wall.x1, wall.x2);
  const end = vertical ? Math.max(wall.y1, wall.y2) : Math.max(wall.x1, wall.x2);
  const len = end - start;
  if (len <= 0) return [];
  const gaps = (wall.openings ?? [])
    .map((o) => ({ from: Math.max(0, o.at_mm), to: Math.min(len, o.at_mm + o.w_mm) }))
    .filter((g) => g.to > g.from)
    .sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];
  for (const g of gaps) {
    const last = merged[merged.length - 1];
    if (last && g.from <= last.to) last.to = Math.max(last.to, g.to);
    else merged.push({ ...g });
  }
  const spans: Array<{ from: number; to: number }> = [];
  let cursor = 0;
  for (const g of merged) {
    if (g.from > cursor) spans.push({ from: cursor, to: g.from });
    cursor = Math.max(cursor, g.to);
  }
  if (cursor < len) spans.push({ from: cursor, to: len });
  return spans.map((s) =>
    vertical
      ? { x1: wall.x1, y1: start + s.from, x2: wall.x1, y2: start + s.to }
      : { x1: start + s.from, y1: wall.y1, x2: start + s.to, y2: wall.y1 },
  );
}

/** Which zone (if any) contains the point — used for drop-to-reparent. When
 *  regions overlap, the smallest wins (the most specific zone). */
export function zoneAt(
  zones: Array<{ id: string; rect: FpRect }>,
  x: number,
  y: number,
): string | null {
  let best: { id: string; area: number } | null = null;
  for (const z of zones) {
    const r = z.rect;
    if (x >= r.x_mm && x < r.x_mm + r.w_mm && y >= r.y_mm && y < r.y_mm + r.d_mm) {
      const area = r.w_mm * r.d_mm;
      if (!best || area < best.area) best = { id: z.id, area };
    }
  }
  return best?.id ?? null;
}

/** The nearest ancestor that owns a plan (has a bound) — placements are in
 *  the plan OWNER's coordinate space, which may be a grandparent (a rack
 *  parented to Bay 1 still draws on the Garage's plan). */
export function planOwnerOf(
  locId: string,
  byId: Map<string, { id: string; parent_id: string | null; metadata: Record<string, unknown> }>,
): string | null {
  let cur = byId.get(locId)?.parent_id ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const p = byId.get(cur);
    if (!p) return null;
    if (readBound(p.metadata)) return p.id;
    cur = p.parent_id;
  }
  return null;
}

/** Re-express a rect from a parent plan's coordinate space into a child
 *  space's LOCAL coordinates — used when a drop reparents an item into a room
 *  that owns its own plan: the item was dropped visually inside the room's
 *  region on the parent plan, so subtracting the region origin lands it at
 *  the equivalent spot on the room's own plan (mm are mm on both planes).
 *  Clamped to the room's bound so an edge drop never clips out. */
export function rebaseRect(rect: FpRect, region: FpRect, targetBound: FpBound): FpRect {
  return clampRect(
    { ...rect, x_mm: rect.x_mm - region.x_mm, y_mm: rect.y_mm - region.y_mm },
    targetBound,
  );
}

// ── collision ────────────────────────────────────────────────────────────────
// A floor plan's whole job is representing physical space, so two things in the
// same place is a mistake worth SHOWING. It is not worth BLOCKING: an item
// genuinely sits inside a bin, and a drag that snapped a hair over a neighbour
// is easier to see and drag back than to be silently refused.
//
// Containment is therefore not a collision — but only real containment. Two
// identical rects each "contain" the other by a naive bounds test, and that is
// the worst case there is (one record perfectly hiding another), so the inner
// rect must also be meaningfully SMALLER to count as being held.

/** Do two rects share any area? Touching edges do not count. */
export function rectsOverlap(a: FpRect, b: FpRect): boolean {
  return (
    a.x_mm < b.x_mm + b.w_mm &&
    b.x_mm < a.x_mm + a.w_mm &&
    a.y_mm < b.y_mm + b.d_mm &&
    b.y_mm < a.y_mm + a.d_mm
  );
}

/** Is `inner` held by `outer` — inside its bounds AND appreciably smaller?
 *  The size test is what stops two identical rects reading as containment. */
export function rectContains(outer: FpRect, inner: FpRect): boolean {
  const within =
    inner.x_mm >= outer.x_mm &&
    inner.y_mm >= outer.y_mm &&
    inner.x_mm + inner.w_mm <= outer.x_mm + outer.w_mm &&
    inner.y_mm + inner.d_mm <= outer.y_mm + outer.d_mm;
  if (!within) return false;
  const outerArea = outer.w_mm * outer.d_mm;
  const innerArea = inner.w_mm * inner.d_mm;
  return outerArea > 0 && innerArea <= outerArea * 0.9;
}

/** Ids of every rect that collides with another: they overlap, and neither is
 *  simply holding the other. O(n²), and a plan holds tens of rects. */
export function collidingIds(items: Array<{ id: string; rect: FpRect }>): Set<string> {
  const hit = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (!rectsOverlap(a.rect, b.rect)) continue;
      if (rectContains(a.rect, b.rect) || rectContains(b.rect, a.rect)) continue;
      hit.add(a.id);
      hit.add(b.id);
    }
  }
  return hit;
}
