// The rules of placing things on the floor plan, kept apart from the screen so
// each one is tested on its own: how many things each place holds, what the
// rail lists and in which order, what a place is called in full, and which
// places a drop on a container can mean.

import type { Location } from "./api";
import { placesOf, type PlaceableRecord } from "./placeableRecords";

/** The kind a place is, for the placement door. */
export const LOCATION_KIND = "core-locations:location";

/** How many things each place holds directly. A thing kept in several places
 *  counts once in each. */
export function countsByPlace(records: PlaceableRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of records) for (const p of placesOf(r)) m.set(p, (m.get(p) ?? 0) + 1);
  return m;
}

/** Everything a place holds, its sub-places included: a garage holds what is in
 *  its toolbox's drawers. */
export function countsWithin(direct: Map<string, number>, locations: Location[]): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const l of locations) if (l.parent_id) children.set(l.parent_id, [...(children.get(l.parent_id) ?? []), l.id]);
  const memo = new Map<string, number>();
  const total = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    let n = direct.get(id) ?? 0;
    for (const c of children.get(id) ?? []) n += total(c, seen);
    memo.set(id, n);
    return n;
  };
  for (const l of locations) total(l.id, new Set());
  return memo;
}

export interface RailFilter {
  /** Show things that already have a place too, not only the unplaced. */
  showAll: boolean;
  q: string;
  /** One collection (a kind id), or every collection. */
  collection: string | null;
}

/** What the rail lists, in its order: things without a place first, then the
 *  rest, each group by name. Placed things only when asked for. */
export function railItems(records: PlaceableRecord[], f: RailFilter): PlaceableRecord[] {
  const q = f.q.trim().toLowerCase();
  const shown = records.filter(
    (r) =>
      (f.collection === null || r.kind === f.collection) &&
      (q === "" || r.name.toLowerCase().includes(q)) &&
      (f.showAll || placesOf(r).length === 0),
  );
  const unplaced = (r: PlaceableRecord) => (placesOf(r).length === 0 ? 0 : 1);
  return shown.sort((a, b) => unplaced(a) - unplaced(b) || a.name.localeCompare(b.name));
}

/** A place in full, outermost first: "Garage › Blue toolbox › Drawer 3". */
export function pathOf(id: string, byId: Map<string, Location>): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
    seen.add(cur.id);
    names.unshift(cur.name);
  }
  return names.join(" › ");
}

export interface PlaceChoice {
  id: string;
  name: string;
  path: string;
  depth: number;
}

/** The places a drop on `id` can mean: the place itself, then everything
 *  inside it, in tree order. A drawer too small to draw is reached here: a drop
 *  on the blue toolbox offers its drawers. */
export function placeChoices(id: string, locations: Location[]): PlaceChoice[] {
  const byId = new Map(locations.map((l) => [l.id, l] as const));
  const children = new Map<string, Location[]>();
  for (const l of locations) if (l.parent_id) children.set(l.parent_id, [...(children.get(l.parent_id) ?? []), l]);
  const order = (a: Location, b: Location) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name, undefined, { numeric: true });
  const out: PlaceChoice[] = [];
  const walk = (loc: Location, depth: number, seen: Set<string>) => {
    if (seen.has(loc.id)) return;
    seen.add(loc.id);
    out.push({ id: loc.id, name: loc.name, path: pathOf(loc.id, byId), depth });
    for (const c of (children.get(loc.id) ?? []).sort(order)) walk(c, depth + 1, seen);
  };
  const root = byId.get(id);
  if (root) walk(root, 0, new Set());
  return out;
}

/** What a place holds, the things pinned to an exact spot on its plan first:
 *  scanning a shelf's code, the thing somebody put at the left end is the
 *  one you are most likely looking for. Otherwise the order it came in. */
export function pinnedFirst<T extends { position?: { x_mm: number; y_mm: number } | null }>(items: T[]): T[] {
  return [...items.filter((i) => i.position), ...items.filter((i) => !i.position)];
}
