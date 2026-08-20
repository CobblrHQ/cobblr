// How many things are actually in a module, when some of them live in instances.
//
// The dashboard tiles for assets and machines used to compute this inline as
//
//     items.length + instanceRows.reduce((a, b) => a + b.total, 0)
//
// which assumes the base list and the instance lists are DISJOINT. They are not.
// Every such module gets a DEFAULT instance (`is_default: true`, instance_name equal
// to the module name), and `/instances/assets/items` returns exactly the same rows as
// `/modules/assets/assets`. So a workspace with 8 assets displayed 16, and 2 machines
// displayed 4 — the tile was adding a list to itself.
//
// It is not simply "use the base count" either: that is the bug this replaced. A
// workspace whose data lives ONLY in non-default instances (Yarn, Wardrobe) has an
// empty base list, and counting just the base showed 0 on a workspace full of things.
//
// Both lists are real, they overlap unpredictably, and only the ids can say by how
// much. So count distinct ids and stop guessing at the relationship.
export function glanceTotal(baseIds: Iterable<string>, instanceIdGroups: Iterable<Iterable<string>>): number {
  const seen = new Set<string>(baseIds);
  for (const group of instanceIdGroups) {
    for (const id of group) seen.add(id);
  }
  return seen.size;
}

/** Pull ids out of a list response. `scope` distinguishes which list the rows came from
 *  (`"base"`, or the instance name).
 *
 *  A row without an id still exists and still has to be counted, so it gets a synthetic
 *  key. That key is scoped deliberately: an unscoped per-index placeholder would make
 *  base row 0 and instance row 0 collide, silently cancelling two unrelated rows into
 *  one. Scoping can only ever over-count an id-less row that genuinely appears in both
 *  lists, which is the safer direction to be wrong in and does not arise in practice —
 *  every row the API returns has an id. */
export function idsOf(items: ReadonlyArray<{ id?: string }> | undefined, scope: string): string[] {
  if (!items) return [];
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const id = items[i]?.id;
    out.push(typeof id === "string" && id ? id : `__no-id-${scope}-${i}__`);
  }
  return out;
}
