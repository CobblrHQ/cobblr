// The real leftover shape of a sheet (#5414). Free space is the sheet minus
// every cut, each outline grown by the kerf-and-spacing margin it was cut
// with. What is usable is that space opened by a minimum_usable_mm square:
// every point left lies in a free square that size. The slivers between
// nested parts go, a triangle offcut stays less its sharpest tips, and an
// untouched sheet or a rectangle offcut keeps its corners (a round opening
// would shave them).
//
// Polygon offsetting needs a robust engine, so this runs on Clipper
// (js-angusj-clipper, MIT, WebAssembly with an asm.js fallback) in integer
// micrometres. It is loaded once, when the module is first imported.
import * as clipper from "js-angusj-clipper";
import type { Point, Rect, SheetSpec } from "./sheet-spec.js";

/** A usable piece of a sheet: its outline, then any holes in it. */
export type Region = Point[][];

const lib = await clipper.loadNativeClipperLibInstanceAsync(clipper.NativeClipperLibRequestedFormat.WasmWithAsmJsFallback);

/** Micrometres per millimetre: Clipper works in integers. */
export const UNIT = 1000;
/** Rounded corners are within 0.05 mm of a true arc. */
const ARC = 0.05 * UNIT;
/** Output is simplified to within 0.1 mm. */
const CLEAN = 0.1 * UNIT;
/** Past these, a sheet is read as rectangles (model "rectangles"), never a
 *  slow or approximate polygon answer. */
export const CUT_VERTEX_CAP = 8192;
export const REGION_VERTEX_CAP = 4096;
/** How many horizontal slabs the rectangle view may cut the regions into. */
const SLAB_CAP = 400;

const toPath = (points: readonly Point[]) => points.map((p) => ({ x: Math.round(p.x * UNIT), y: Math.round(p.y * UNIT) }));
const toPoints = (path: readonly { x: number; y: number }[]) => path.map((p) => ({ x: p.x / UNIT, y: p.y / UNIT }));
const rectPath = (r: Rect) => toPath([{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }]);
const vertices = (paths: readonly (readonly unknown[])[]) => paths.reduce((n, p) => n + p.length, 0);

/** Grown by a margin with round corners, as a beam's kerf is round. */
function grow(paths: clipper.ReadonlyPaths, delta: number): clipper.Paths {
  if (!paths.length) return [];
  if (delta === 0) return paths.map((p) => [...p]);
  return lib.offsetToPaths({ delta, arcTolerance: ARC, offsetInputs: [{ data: paths, joinType: clipper.JoinType.Round, endType: clipper.EndType.ClosedPolygon }] }) ?? [];
}

/** Grown by a square of half-side h: the shape swept along its edges, with
 *  what it already covered. */
function growSquare(paths: clipper.ReadonlyPaths, h: number): clipper.Paths {
  if (!paths.length) return [];
  const square = [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }];
  return lib.polyTreeToPaths(clip(clipper.ClipType.Union, paths, lib.minkowskiSumPaths(square, paths, true)));
}

function clip(type: clipper.ClipType, subject: clipper.ReadonlyPaths, against: clipper.ReadonlyPaths): clipper.PolyTree {
  return lib.clipToPolyTree({ clipType: type, subjectInputs: [{ data: subject, closed: true }], clipInputs: against.length ? [{ data: against }] : [], subjectFillType: clipper.PolyFillType.NonZero, clipFillType: clipper.PolyFillType.NonZero });
}

/** A Clipper tree as regions: each outer contour with its holes, and any
 *  island inside a hole as a region of its own. */
function regionsOf(tree: clipper.PolyTree): Region[] {
  const out: Region[] = [];
  const walk = (nodes: readonly clipper.PolyNode[]) => {
    for (const outer of nodes) {
      const path = lib.cleanPolygon(outer.contour, CLEAN);
      if (path.length < 3) continue;
      const holes = outer.childs.map((h) => lib.cleanPolygon(h.contour, CLEAN)).filter((h) => h.length >= 3);
      out.push([toPoints(path), ...holes.map(toPoints)]);
      for (const hole of outer.childs) walk(hole.childs);
    }
  };
  walk(tree.childs);
  return out;
}

const pathsOf = (regions: readonly Region[]) => regions.flatMap((r) => r.map(toPath));

/** The usable leftover of a sheet, or null when its cuts are past the caps. */
export function freeRegions(s: SheetSpec, used: readonly Rect[], polygons: readonly Point[][], margins: readonly number[]): Region[] | null {
  if (vertices(polygons) > CUT_VERTEX_CAP) return null;
  const grown: clipper.Paths = used.map(rectPath);
  const byMargin = new Map<number, clipper.Paths>();
  polygons.forEach((p, i) => {
    const m = Math.max(0, margins[i] ?? 0);
    byMargin.set(m, [...(byMargin.get(m) ?? []), toPath(p)]);
  });
  for (const [m, paths] of byMargin) grown.push(...grow(paths, m * UNIT));
  const sheet = [rectPath({ x: 0, y: 0, width: s.width_mm, height: s.height_mm })];
  const cuts = grown.length ? lib.polyTreeToPaths(clip(clipper.ClipType.Union, grown, [])) : [];
  const free = lib.polyTreeToPaths(clip(clipper.ClipType.Difference, sheet, cuts));
  // The square is a micrometre short of the minimum on each side: a strip
  // exactly the minimum wide has its squares' centres on a line, which has no
  // area and would vanish, though the minimum counts as usable.
  const half = s.minimum_usable_mm / 2 - 1 / UNIT;
  if (2 * half > Math.min(s.width_mm, s.height_mm)) return [];
  // Where a square's centre can sit: inside the sheet by half its side, and
  // clear of every cut grown by the square.
  const inner = [rectPath({ x: half, y: half, width: s.width_mm - 2 * half, height: s.height_mm - 2 * half })];
  const centres = lib.polyTreeToPaths(clip(clipper.ClipType.Difference, inner, growSquare(cuts, Math.round(half * UNIT))));
  const opened = growSquare(centres, Math.round(half * UNIT));
  if (!opened.length) return [];
  // Growing back can round past a straight edge by the arc tolerance; the
  // opening of a set lies inside it, so keep it there.
  const regions = regionsOf(clip(clipper.ClipType.Intersection, opened, free));
  return vertices(regions.flat()) > REGION_VERTEX_CAP ? null : regions;
}

/** Area in mm², holes taken out. */
export function regionsArea(regions: readonly Region[]): number {
  return regions.reduce((n, r) => n + r.reduce((m, ring, i) => m + (i ? -1 : 1) * Math.abs(lib.area(toPath(ring))), 0), 0) / UNIT / UNIT;
}

/** Rectangles as regions, overlaps merged: the rectangle model's leftover. */
export function regionsOfRectangles(rects: readonly Rect[]): Region[] {
  if (!rects.length) return [];
  const paths = rects.map(rectPath);
  return regionsOf(clip(clipper.ClipType.Union, paths, []));
}

/** The regions cut into horizontal slabs, as the rectangles wholly inside
 *  them in each slab, in integer micrometres (UNIT) so one slab's top is
 *  exactly the next one's bottom. Slab edges fall on every vertex height, so the boundary
 *  edges crossing a slab are straight and never cross inside it: paired left
 *  to right in their order across the slab, each pair bounds a piece, and the
 *  piece's inner rectangle runs from the further-in end of its left edge to
 *  the further-in end of its right one. Taller gaps are split so a sloping
 *  edge reads as a fine staircase. */
export function regionSlabs(s: SheetSpec, regions: readonly Region[]): Rect[] {
  const paths = pathsOf(regions);
  if (!paths.length) return [];
  const edges = paths.flatMap((p) => p.map((a, i) => { const b = p[(i + 1) % p.length]!; return a.y < b.y ? { lo: a, hi: b } : { lo: b, hi: a }; })).filter((e) => e.hi.y > e.lo.y);
  const ys = [...new Set(paths.flatMap((p) => p.map((v) => v.y)))].sort((a, b) => a - b);
  const step = Math.max((s.minimum_usable_mm / 4) * UNIT, ((ys[ys.length - 1]! - ys[0]!) / SLAB_CAP) * 2);
  const cuts: number[] = [ys[0]!];
  for (const y of ys.slice(1)) {
    const from = cuts[cuts.length - 1]!, parts = Math.ceil((y - from) / step);
    for (let k = 1; k < parts; k++) cuts.push(Math.round(from + ((y - from) * k) / parts));
    cuts.push(y);
  }
  const slabs = cuts.length - 1 > SLAB_CAP ? ys : cuts;
  const at = (e: (typeof edges)[number], y: number) => e.lo.x + ((e.hi.x - e.lo.x) * (y - e.lo.y)) / (e.hi.y - e.lo.y);
  const out: Rect[] = [];
  for (let i = 1; i < slabs.length; i++) {
    const y0 = slabs[i - 1]!, y1 = slabs[i]!, mid = (y0 + y1) / 2;
    const crossing = edges.filter((e) => e.lo.y <= y0 && e.hi.y >= y1).map((e) => ({ x0: at(e, y0), x1: at(e, y1), xm: at(e, mid) })).sort((a, b) => a.xm - b.xm);
    for (let k = 0; k + 1 < crossing.length; k += 2) {
      const l = crossing[k]!, r = crossing[k + 1]!;
      const left = Math.max(l.x0, l.x1), right = Math.min(r.x0, r.x1);
      const l0 = Math.ceil(left), r0 = Math.floor(right);
      if (r0 > l0) out.push({ x: l0, y: y0, width: r0 - l0, height: y1 - y0 });
    }
  }
  return out;
}
