// Things drawn at their real size, and whether they fit where they stand.
//
// A placed thing with an outer size (the `outer-size` field role) is drawn as
// a rectangle: its footprint (width × depth) on a floor, its face (width ×
// height) on a shelf. On a shelf they stand side by side from the left, in
// their order, so the row says at a glance whether they fit: "3 machines,
// 1,310 of 1,220 mm: doesn't fit". A thing deeper than the shelf hangs off
// the front, and one taller than the space hits the shelf above.
// See docs/design-decisions/location-floor-plan.md, "Things at their real size".

import { OUTER_SIZE_ROLE, parseOuterSize, type OuterSize } from "@cobblr/platform-contract/outer-size";
import type { FpRect } from "./floorplanGeometry";

/** The size a record carries, read through its kind's outer-size field(s). */
export function outerSizeOf(
  values: Record<string, unknown> | null | undefined,
  sizeFields: readonly string[],
): OuterSize | null {
  if (!values) return null;
  for (const f of sizeFields) {
    const s = parseOuterSize(values[f]);
    if (s) return s;
  }
  return null;
}

/** The names of the fields that carry a kind's outer size. */
export function sizeFieldNames(defs: ReadonlyArray<{ name: string; field_role?: string | null; entity_kind?: string }>, kind: string): string[] {
  return defs.filter((d) => d.field_role === OUTER_SIZE_ROLE && (!d.entity_kind || d.entity_kind === kind)).map((d) => d.name);
}

/** A sized thing's footprint on a floor, centred on where it was pinned. */
export function footprintAt(size: OuterSize, at: { x_mm: number; y_mm: number }): FpRect {
  return { x_mm: Math.round(at.x_mm - size.w_mm / 2), y_mm: Math.round(at.y_mm - size.d_mm / 2), w_mm: size.w_mm, d_mm: size.d_mm };
}

export interface ShelfThing {
  key: string;
  size: OuterSize;
  /** Where it stands along the shelf, when somebody put it there; else it
   *  goes after the ones that have a spot, in name order. */
  order: number | null;
  name: string;
}

export interface ShelfRow {
  /** Each thing's face rect, in the face's own mm. */
  rects: Map<string, FpRect>;
  used_mm: number;
  fits: boolean;
  /** Deeper than the shelf: it hangs off the front. */
  overhang: Set<string>;
  /** Taller than the space above the shelf. */
  tooTall: Set<string>;
  order: string[];
}

/** Stand the things on a shelf side by side from its left end, on its floor.
 *  `shelf` is the shelf's space on the face (width × height); `depth_mm` is
 *  how deep the shelf is, when known. */
export function shelfRow(shelf: FpRect, things: readonly ShelfThing[], depth_mm: number | null, band_mm = 0): ShelfRow {
  const sorted = [...things].sort((a, b) => {
    if (a.order !== null && b.order !== null) return a.order - b.order;
    if (a.order !== null) return -1;
    if (b.order !== null) return 1;
    return a.name.localeCompare(b.name);
  });
  const rects = new Map<string, FpRect>();
  const overhang = new Set<string>();
  const tooTall = new Set<string>();
  let x = shelf.x_mm;
  for (const t of sorted) {
    // The top `band_mm` of a shelf is its label band (its name and its fit):
    // a thing is drawn below it, never over the words.
    const room = Math.max(1, shelf.d_mm - band_mm);
    const h = Math.min(t.size.h_mm ?? Math.min(shelf.d_mm, t.size.d_mm), room);
    rects.set(t.key, { x_mm: x, y_mm: shelf.y_mm + shelf.d_mm - h, w_mm: t.size.w_mm, d_mm: h });
    x += t.size.w_mm;
    if (depth_mm && t.size.d_mm > depth_mm) overhang.add(t.key);
    if (t.size.h_mm && t.size.h_mm > shelf.d_mm) tooTall.add(t.key);
  }
  const used = x - shelf.x_mm;
  return { rects, used_mm: used, fits: used <= shelf.w_mm, overhang, tooTall, order: sorted.map((t) => t.key) };
}

const mm = (v: number) => v.toLocaleString("en-US");

/** "3 machines, 1,310 of 1,220 mm: 90 mm too wide" / "2 machines, 900 of 1,220 mm: 320 mm free". */
export function shelfFitLine(row: ShelfRow, shelfWidth: number, noun: { one: string; many: string }, count: number): string {
  const what = `${count} ${count === 1 ? noun.one : noun.many}`;
  const tail = row.fits ? `${mm(shelfWidth - row.used_mm)} mm free` : `${mm(row.used_mm - shelfWidth)} mm too wide`; // count-unit-ok: mm is a length symbol
  return `${what}, ${mm(row.used_mm)} of ${mm(shelfWidth)} mm: ${tail}`; // count-unit-ok: mm is a length symbol
}

/** The shelf's order after a thing is dragged to `x_mm` (in the shelf's own
 *  mm, from its left end), and the spot each thing then stands at: what a
 *  reorder writes, every thing on the shelf at once, so the row reads the
 *  same however it got there. */
export function reorderTo(row: ShelfRow, shelf: FpRect, movingKey: string, x_mm: number): Array<{ key: string; x_mm: number }> {
  const others = row.order.filter((k) => k !== movingKey);
  const local = (k: string) => {
    const r = row.rects.get(k)!;
    return r.x_mm - shelf.x_mm + r.w_mm / 2;
  };
  let i = others.findIndex((k) => x_mm < local(k));
  if (i === -1) i = others.length;
  const order = [...others.slice(0, i), movingKey, ...others.slice(i)];
  let at = 0;
  return order.map((key) => {
    const spot = { key, x_mm: at };
    at += row.rects.get(key)!.w_mm;
    return spot;
  });
}

/** A shelf's name inside its own rack's view, without the rack's name in
 *  front of it: "Shelf 1" on Rack 1's face, not "Rack 1 shelf 1". */
export function nameUnder(name: string, parent: string): string {
  const p = parent.trim();
  if (!p || name.length <= p.length + 1 || name.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return name;
  // A whole word: "Rack 10 shelf 1" is not under "Rack 1".
  if (!/[\s:,·>›-]/.test(name.charAt(p.length))) return name;
  const rest = name.slice(p.length).replace(/^[\s:,·>›-]+/, "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : name;
}
