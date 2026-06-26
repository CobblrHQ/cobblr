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
