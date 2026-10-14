// Pure geometry + metadata readers for the location floor plan. Kept free of
// React so the math is unit-testable. All values are integer mm; origin is
// the bound's top-left; x → right, y → down.
// See docs/design-decisions/location-floor-plan.md.

import { fieldKindOf } from "@cobblr/platform-contract/kind-label";
import { boxHolds, collisions, doorFitsWall, isEdge, isRotation, readCloset, wallSegments as contractWallSegments, type PlanOpening, type PlanWall, type Rotation } from "@cobblr/platform-contract/plan-clearance";

/** A door, a window or a plain opening in a wall; a door may say its leaf,
 *  hinge and swing, a window its sill (plan-clearance.ts). */
export type FpOpening = PlanOpening;

export type FpWall = PlanWall;

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
  /** The grid drawn on this plan in every mode, and what pins snap to. Off
   *  until somebody turns it on; remembered on the plan. */
  grid_on?: boolean;
  /** The field this plan groups its pinned things by ("drive"), remembered
   *  with the plan; any measure or choice field their kinds declare. */
  group_by?: string;
  /** The aisle a room's planner checks gaps against, mm; absent, it is off. */
  aisle_mm?: number;
  walls?: FpWall[];
}

export interface FpRect {
  x_mm: number;
  y_mm: number;
  w_mm: number;
  d_mm: number;
  wall_mounted?: boolean;
  /** A quarter turn: w × d are as it stands on the plan. */
  rot?: Rotation;
}

export const SNAP_MM = 100;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** A bound read off one blob: the room's floorplan, or a container's face. */
function boundFrom(fp: Record<string, unknown>): FpBound | null {
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
        for (const raw of wl.openings) {
          const o = raw as Record<string, unknown>;
          const at = num(o.at_mm);
          const ow = num(o.w_mm);
          if (at === null || ow === null || ow <= 0) continue;
          const kind = o.kind === "door" || o.kind === "window" || o.kind === "opening" ? o.kind : undefined;
          const leaf = num(o.leaf_mm);
          const sill = num(o.sill_mm);
          const door = { hinge: isEdge(o.hinge) ? o.hinge : undefined, swing: isEdge(o.swing) ? o.swing : undefined };
          // A hinge or swing that cannot go on this wall (left on a wall that
          // runs down) is read as not said, never drawn the wrong way.
          const fits = doorFitsWall({ x1, y1, x2, y2 }, door);
          openings.push({
            at_mm: at,
            w_mm: ow,
            ...(kind ? { kind } : {}),
            ...(kind === "door" && fits && door.hinge ? { hinge: door.hinge } : {}),
            ...(kind === "door" && fits && door.swing ? { swing: door.swing } : {}),
            ...(kind === "door" && leaf ? { leaf_mm: leaf } : {}),
            ...(kind === "window" && sill !== null ? { sill_mm: sill } : {}),
          });
        }
      }
      walls.push({ x1, y1, x2, y2, ...(openings.length ? { openings } : {}), ...(typeof wl.closet === "string" && wl.closet ? { closet: wl.closet } : {}) });
    }
  }
  const grid = num(fp.grid_mm);
  return {
    w_mm: w,
    d_mm: d,
    unit: fp.unit === "ft" || fp.unit === "in" || fp.unit === "m" || fp.unit === "cm" || fp.unit === "mm" ? fp.unit : undefined,
    view: fp.view === "front" ? "front" : fp.view === "plan" ? "plan" : undefined,
    ...(grid && grid >= 5 && grid <= 1000 ? { grid_mm: grid } : {}),
    ...(typeof fp.grid_on === "boolean" ? { grid_on: fp.grid_on } : {}),
    ...(typeof fp.group_by === "string" && fp.group_by ? { group_by: fp.group_by } : {}),
    ...(num(fp.aisle_mm) ? { aisle_mm: num(fp.aisle_mm)! } : {}),
    ...(walls.length ? { walls } : {}),
  };
}

function blob(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const fp = metadata?.floorplan;
  return fp && typeof fp === "object" && !Array.isArray(fp) ? (fp as Record<string, unknown>) : null;
}

function faceOf(fp: Record<string, unknown> | null): Record<string, unknown> | null {
  const f = fp?.face;
  return f && typeof f === "object" && !Array.isArray(f) ? (f as Record<string, unknown>) : null;
}

/** The bound (room dims + walls) off a location's metadata, or null. Reads
 *  defensively — metadata is a free jsonb and may hold anything.
 *
 *  A container's own layout, its front face with the drawers drawn on it, is
 *  a different measurement from the footprint it takes on the room's floor,
 *  so it lives under `floorplan.face`. A record written before the two were
 *  split carries one shared w × d, read as both until its first write
 *  (withRect) splits them. */
export function readBound(metadata: Record<string, unknown> | null | undefined): FpBound | null {
  const fp = blob(metadata);
  if (!fp) return null;
  const face = faceOf(fp);
  if (face) return boundFrom(face);
  // A closet's size is where it stands in its room, not a plan of its own:
  // what is put in it is drawn on the room's plan (plan-clearance.ts).
  if (readCloset(fp)) return null;
  return boundFrom(fp);
}

/** Does this location own a layout somebody set up (a face, a room's own
 *  size), and not only the size of its rect on its parent's plan? A drawer
 *  placed on a toolbox face has a w × d, which reads as a bound, but nothing
 *  is laid out in it. */
export function hasOwnLayout(metadata: Record<string, unknown> | null | undefined): boolean {
  const fp = blob(metadata);
  if (!fp) return false;
  const face = faceOf(fp);
  if (face) return !!boundFrom(face);
  if (!boundFrom(fp)) return false;
  if (num(fp.x_mm) === null || num(fp.y_mm) === null) return true;
  return fp.view !== undefined || fp.unit !== undefined || fp.grid_mm !== undefined || fp.grid_on !== undefined || Array.isArray(fp.walls);
}

const BOUND_KEYS = ["w_mm", "d_mm", "unit", "view", "grid_mm", "grid_on", "group_by", "aisle_mm", "walls"] as const;
const RECT_KEYS = ["x_mm", "y_mm", "w_mm", "d_mm", "wall_mounted", "rot"] as const;

function boundKeys(b: FpBound): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of BOUND_KEYS) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

/** What a location is, for where its layout is kept: a room's floor is its
 *  footprint; a container's face is not. */
export type LayoutKind = "area" | "container";

/** Metadata with this location's own layout set, everything else kept (a
 *  location's metadata holds more than the plan, and a placed container keeps
 *  its spot on the room). A container's goes to its face. */
export function withBound(
  metadata: Record<string, unknown> | null | undefined,
  bound: FpBound,
  kind: LayoutKind,
): Record<string, unknown> {
  const meta = { ...(metadata ?? {}) };
  const fp = { ...(blob(metadata) ?? {}) };
  if (kind === "container") {
    fp.face = boundKeys(bound);
    if (num(fp.x_mm) === null) for (const k of BOUND_KEYS) delete fp[k];
  } else {
    for (const k of BOUND_KEYS) delete fp[k];
    Object.assign(fp, boundKeys(bound));
  }
  meta.floorplan = fp;
  return meta;
}

/** Metadata with this record's spot on its parent's plan set (or cleared),
 *  everything else kept. `keepFace`: a container that has a layout of its
 *  own, from before the face was split out, has it saved as its face first,
 *  so moving or resizing it on the floor never stretches its drawers. */
export function withRect(
  metadata: Record<string, unknown> | null | undefined,
  rect: FpRect | null,
  opts: { keepFace?: boolean } = {},
): Record<string, unknown> {
  const meta = { ...(metadata ?? {}) };
  const fp = { ...(blob(metadata) ?? {}) };
  if (opts.keepFace && !faceOf(fp)) {
    const legacy = boundFrom(fp);
    if (legacy) {
      fp.face = boundKeys(legacy);
      for (const k of BOUND_KEYS) if (k !== "w_mm" && k !== "d_mm") delete fp[k];
    }
  }
  if (rect) {
    Object.assign(fp, { x_mm: rect.x_mm, y_mm: rect.y_mm, w_mm: rect.w_mm, d_mm: rect.d_mm });
    if (rect.wall_mounted) fp.wall_mounted = true;
    else delete fp.wall_mounted;
    if (rect.rot) fp.rot = rect.rot;
    else delete fp.rot;
  } else {
    for (const k of RECT_KEYS) delete fp[k];
  }
  if (Object.keys(fp).length) meta.floorplan = fp;
  else delete meta.floorplan;
  return meta;
}

/** Metadata with decoration keys (fill, outline) patched; null removes one. */
export function withDecor(
  metadata: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const meta = { ...(metadata ?? {}) };
  const fp = { ...(blob(metadata) ?? {}), ...patch };
  for (const k of Object.keys(fp)) if (fp[k] === undefined || fp[k] === null) delete fp[k];
  meta.floorplan = fp;
  return meta;
}

/** A child's placement rect off its metadata, or null (unplaced). A blob that
 *  parses as a bound but not a rect is NOT a placement. */
export function readRect(metadata: Record<string, unknown> | null | undefined): FpRect | null {
  const fp = (metadata?.floorplan ?? null) as Record<string, unknown> | null;
  if (!fp) return null;
  const x = num(fp.x_mm), y = num(fp.y_mm), w = num(fp.w_mm), d = num(fp.d_mm);
  if (x === null || y === null || !w || !d) return null;
  return { x_mm: x, y_mm: y, w_mm: w, d_mm: d, wall_mounted: fp.wall_mounted === true, ...(isRotation(fp.rot) ? { rot: fp.rot } : {}) };
}

export function partitionPlanRecords<
  R extends { kind: string; id: string; metadata: Record<string, unknown> },
  P extends { kind: string; id: string; instance?: string | null; position?: { x_mm: number; y_mm: number } | null },
>(records: readonly R[], contents: readonly P[], bound: FpBound | null) {
  const pins = contents.filter(({ position: p }) => p && bound &&
    Number.isFinite(p.x_mm) && Number.isFinite(p.y_mm) &&
    p.x_mm >= 0 && p.y_mm >= 0 && p.x_mm <= bound.w_mm && p.y_mm <= bound.d_mm);
  const pinned = new Set(pins.map((p) => `${fieldKindOf(p)}:${p.id}`));
  const placedOccupants: Array<{ ent: R; rect: FpRect }> = [];
  const unplacedOccupants: R[] = [];
  for (const ent of records) {
    if (pinned.has(`${fieldKindOf(ent)}:${ent.id}`)) continue;
    const rect = readRect(ent.metadata);
    if (rect) placedOccupants.push({ ent, rect });
    else unplacedOccupants.push(ent);
  }
  return { pins, placedOccupants, unplacedOccupants };
}

/** The first spot, in reading order (top-left first), where a w × d rect sits
 *  on the bound without covering anything already there: a new thing lands
 *  where the person is looking, never on top of another. With no room left it
 *  goes top-left and the collision outline shows it. */
export function freeSpot(bound: FpBound, taken: FpRect[], w: number, d: number): FpRect {
  const cell = bound.grid_mm ?? SNAP_MM;
  const ww = Math.max(cell, Math.min(w, bound.w_mm));
  const dd = Math.max(cell, Math.min(d, bound.d_mm));
  const step = Math.max(cell, snap(Math.min(ww, dd) / 4, cell));
  for (let y = 0; y + dd <= bound.d_mm; y += step) {
    for (let x = 0; x + ww <= bound.w_mm; x += step) {
      const c = { x_mm: x, y_mm: y, w_mm: ww, d_mm: dd };
      if (!taken.some((t) => rectsOverlap(t, c))) return c;
    }
  }
  return clampRect({ x_mm: 0, y_mm: 0, w_mm: ww, d_mm: dd }, bound);
}

/** The rect a new child gets. On a face (front view) a drawer: the face's full
 *  width, one row's height (the height the drawers already there share, or a
 *  quarter of the face), under the ones already there. On a floor: a 4 × 2 ft
 *  piece of furniture, or a third of a small room, at the first free spot. */
export function newChildRect(bound: FpBound, taken: FpRect[]): FpRect {
  const g = bound.grid_mm ?? SNAP_MM;
  if (bound.view === "front") {
    const heights = new Map<number, number>();
    for (const t of taken) heights.set(t.d_mm, (heights.get(t.d_mm) ?? 0) + 1);
    const common = [...heights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const d = common ?? Math.max(g, snap(bound.d_mm / 4, g));
    return freeSpot(bound, taken, bound.w_mm, d);
  }
  return freeSpot(bound, taken, Math.min(1200, snap(bound.w_mm / 3, g) || g), Math.min(600, snap(bound.d_mm / 3, g) || g));
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
 *  One implementation, the contract's, so the plan, the print and the
 *  clearance checks agree on where a wall is solid. */
export const wallSegments = contractWallSegments;

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

/** Is `inner` held by `outer`: inside its bounds AND appreciably smaller?
 *  The size test is what stops two identical rects reading as containment. */
export function rectContains(outer: FpRect, inner: FpRect): boolean {
  return boxHolds(outer, inner);
}

/** Ids of every rect that collides with another: they overlap, and neither is
 *  a place (`holds`) holding the other. Two things never hold each other, so
 *  a printer set down inside another printer's footprint collides (#6368).
 *  The rule is plan-clearance's `collisions`, so the planner says the same. */
export function collidingIds(items: Array<{ id: string; rect: FpRect; holds?: boolean }>): Set<string> {
  const hit = new Set<string>();
  for (const [a, b] of collisions(items.map((i) => ({ id: i.id, box: i.rect, holds: i.holds })))) {
    hit.add(a.id);
    hit.add(b.id);
  }
  return hit;
}

/** How many cells of a grid a size takes: every cell it reaches into, so a
 *  20 mm socket on a 42 mm grid takes one, never "0" (#5990). A size that is
 *  a whole number of cells takes exactly that many (84 mm is 2 of 42, not 3). */
export function gridCells(mm: number, grid: number): number {
  if (!(grid > 0) || !(mm > 0)) return 0;
  return Math.max(1, Math.ceil(mm / grid - 1e-6));
}

/** The grid note beside a footprint's sizes: the cells it takes, and in
 *  words what that means. */
export function gridCellsNote(rect: { w_mm: number; d_mm: number }, grid: number): { text: string; title: string } {
  const w = gridCells(rect.w_mm, grid);
  const d = gridCells(rect.d_mm, grid);
  return { text: `${w} × ${d} u`, title: `Takes ${w} × ${d} cells of the ${grid} mm grid` };
}
