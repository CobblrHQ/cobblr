// THE shared locations tree+sort model. One source of truth so every surface
// that shows the location hierarchy — the Locations page, the Labels browser,
// future pickers — renders the SAME structure in the SAME order. Before this,
// each surface rebuilt its own tree and they drifted (the Labels browser
// lexically sorted "Bin 1, Bin 10, Bin 11, Bin 2…" while the Locations page
// natural-sorted "Bin 1, Bin 2, … Bin 10, Bin 11").
//
// Generic over the consumer's row type via accessors, so neither the page's
// `Location` nor the browser's item shape has to be renamed to share this.
// Pure (no React) — callers wrap it in useMemo and render however they like.

/** A node = the consumer's item plus its sorted children. */
export type LocationNode<T> = T & { children: LocationNode<T>[] };

export interface LocationAccessors<T> {
  id: (x: T) => string;
  parentId: (x: T) => string | null;
  /** Manual order set by drag (the `position` column). Lower = earlier. */
  position: (x: T) => number;
  /** Display name, used for the natural-order tiebreak within a sibling group. */
  name: (x: T) => string;
  /** True for a container (bin/drawer/shelf); anything else is an area (room). */
  isContainer: (x: T) => boolean;
}

// Numeric collation: "Bin 2" before "Bin 10" — the human order. One shared
// collator so the tiebreak is identical everywhere.
const NATURAL = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Build the location forest, split into the **areas** roots (the room tree,
 *  with containers nesting inside them) and the **loose container** roots (bins
 *  not filed into any area) — the same split the Locations page draws. Siblings
 *  at every level are ordered by manual `position`, then natural name. */
export function buildLocationForest<T>(
  items: T[],
  a: LocationAccessors<T>,
): { areas: LocationNode<T>[]; containers: LocationNode<T>[] } {
  const byId = new Map<string, LocationNode<T>>();
  for (const it of items) byId.set(a.id(it), { ...(it as T), children: [] } as LocationNode<T>);
  const roots: LocationNode<T>[] = [];
  for (const n of byId.values()) {
    const pid = a.parentId(n);
    const parent = pid ? byId.get(pid) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const cmp = (x: LocationNode<T>, y: LocationNode<T>) =>
    a.position(x) - a.position(y) || NATURAL.compare(a.name(x), a.name(y));
  const sortRec = (arr: LocationNode<T>[]) => {
    arr.sort(cmp);
    for (const c of arr) sortRec(c.children);
  };
  sortRec(roots);
  return {
    areas: roots.filter((r) => !a.isContainer(r)),
    containers: roots.filter((r) => a.isContainer(r)),
  };
}

/** The view `group_by` value that means "roll each row up to its room (area)".
 *  A reserved key — no custom field may be named this — so grouping by location
 *  is generic, not a per-bundle text field. */
export const LOCATION_GROUP_KEY = "location";

/** Build a resolver that maps a location id → the AREA (room) it rolls up to:
 *  the nearest ancestor-or-self that is NOT a container. A bin resolves to its
 *  room; a thing filed directly in an area resolves to that area; an orphan
 *  container with no area ancestor resolves to itself (grouped, never dropped).
 *  Returns null for no/unknown id so the caller can bucket it as "unfiled".
 *  Builds the id index once; cycle-safe. This is how a list groups "by location"
 *  at the useful room level instead of a long tail of per-bin groups. */
export function makeAreaResolver<T>(
  items: T[],
  a: LocationAccessors<T>,
): (locationId: string | null | undefined) => string | null {
  const byId = new Map<string, T>();
  for (const it of items) byId.set(a.id(it), it);
  return (locationId) => {
    if (!locationId) return null;
    let cur = byId.get(locationId);
    if (!cur) return null;
    const seen = new Set<string>();
    let deepest = cur;
    while (cur && !seen.has(a.id(cur))) {
      if (!a.isContainer(cur)) return a.name(cur);
      seen.add(a.id(cur));
      deepest = cur;
      const pid = a.parentId(cur);
      cur = pid ? byId.get(pid) : undefined;
    }
    return a.name(deepest);
  };
}

/** Flatten an AREA forest to just the areas, pre-order — recursing only into
 *  non-container children, so the containers nested under an area never leak
 *  into an "areas" list (the bug: a generic flatten walked ALL children and a
 *  room's bins rendered as rooms). */
export function flattenAreaForest<T>(
  nodes: LocationNode<T>[],
  a: LocationAccessors<T>,
): LocationNode<T>[] {
  const out: LocationNode<T>[] = [];
  const walk = (ns: LocationNode<T>[]) => {
    for (const n of ns) {
      if (a.isContainer(n)) continue;
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export interface AreaContainerGroup<T> {
  /** The room these containers live in; null = LOOSE containers under no room. */
  area: T | null;
  /** The area's container descendants in tree PRE-ORDER — a shelf appears
   *  immediately before the bins that sit on it. */
  containers: T[];
}

/** Containers grouped by the room they roll up to (nearest area ancestor), in
 *  the forest's display order — so a picker can show "In Garage: Metal Rack,
 *  Bin 4…" instead of one flat wall where shelves/racks/closets intermingle
 *  with loose bins. A container nested under another container stays with that
 *  container's room. Loose containers (no area anywhere above) come last as the
 *  `area: null` group. Only non-empty groups are returned. */
export function groupContainersByArea<T>(
  items: T[],
  a: LocationAccessors<T>,
): AreaContainerGroup<T>[] {
  const { areas, containers } = buildLocationForest(items, a);
  const groups: AreaContainerGroup<T>[] = [];
  // A container node with every container nested below it, pre-order.
  const withDescendants = (n: LocationNode<T>): T[] => {
    const out: T[] = [n];
    for (const c of n.children) if (a.isContainer(c)) out.push(...withDescendants(c));
    return out;
  };
  // Every AREA (nested areas included) owns its DIRECT container subtrees; its
  // nested areas own their own.
  const walkArea = (n: LocationNode<T>) => {
    const mine: T[] = [];
    for (const c of n.children) if (a.isContainer(c)) mine.push(...withDescendants(c));
    if (mine.length > 0) groups.push({ area: n, containers: mine });
    for (const c of n.children) if (!a.isContainer(c)) walkArea(c);
  };
  for (const r of areas) walkArea(r);
  const loose: T[] = [];
  for (const r of containers) loose.push(...withDescendants(r));
  if (loose.length > 0) groups.push({ area: null, containers: loose });
  return groups;
}

/** Ancestor ids of `id`, nearest-first (parent, grandparent, ...). Cycle-safe;
 *  empty for an unknown id or a root. Lets a picker auto-expand the chain above
 *  a pre-selected location so the selection is visible. */
export function ancestorIds<T>(items: T[], a: LocationAccessors<T>, id: string): string[] {
  const byId = new Map(items.map((x) => [a.id(x), x]));
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = byId.get(id);
  while (cur) {
    const pid = a.parentId(cur);
    if (!pid || seen.has(pid)) break;
    seen.add(pid);
    out.push(pid);
    cur = byId.get(pid);
  }
  return out;
}

export interface FlatLocation<T> {
  node: LocationNode<T>;
  depth: number;
}

/** Pre-order flatten of a forest (parents immediately before their children),
 *  carrying each node's depth — for indented-list renderers like the Labels
 *  browser. The nested-card renderer (Locations page) walks `.children` directly
 *  instead. */
export function flattenLocationForest<T>(nodes: LocationNode<T>[]): FlatLocation<T>[] {
  const out: FlatLocation<T>[] = [];
  const walk = (ns: LocationNode<T>[], depth: number) => {
    for (const n of ns) {
      out.push({ node: n, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}
