// A category that NAMES a sibling list is a routing answer, not a category.
//
// A workspace with a Teas list and a Groceries list ended up with green tea,
// baking powder and vanilla extract in the base Inventory table, each wearing
// an inventory category called "Teas", "tea", "Groceries" or "baking
// ingredient" (2026-09-08). The model had recognised the kind of thing exactly
// and then expressed it as a category inside the catch-all table, so the tea
// was invisible under Teas. Two readers need the same rule: the scan router,
// so a new scan lands in the list its category names; and the inventory list,
// so the ones already filed that way are offered a move.

export interface InstanceLike {
  /** The instance name as the platform knows it ("tea"). */
  instance: string;
  /** What the list is called ("Teas"). */
  label: string;
  /** The singular noun for one record ("tea"), when declared. */
  noun?: string | null;
  /** Extra words the list claims ("herbal tea", "tea bags"). */
  keywords?: readonly string[] | null;
}

/** One form for "Teas", "tea", "Tea ", "TEAS": lowercase, letters and digits
 *  only, trailing plural stripped. Two words match when both reduce to the
 *  same form. */
export function normalizeLabel(s: string): string {
  const w = s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((t) => t.replace(/(ies)$/, "y").replace(/(ches|shes|xes|ses)$/, (m) => m.slice(0, -2)).replace(/s$/, ""));
  return w.join(" ");
}

/** The sibling list this category names, or null. Exact after normalising:
 *  "Teas" finds the tea list, "Condiments" finds a Condiments list and
 *  nothing else; "Groceries" finds Groceries. A category that merely CONTAINS
 *  a list's name ("tea towels") does not, because that is a different thing. */
export function instanceForCategory<T extends InstanceLike>(
  category: string | null | undefined,
  options: readonly T[],
): T | null {
  if (!category) return null;
  const want = normalizeLabel(category);
  if (!want) return null;
  for (const o of options) {
    const names = [o.instance, o.label, o.noun ?? "", ...(o.keywords ?? [])].map(normalizeLabel).filter(Boolean);
    if (names.includes(want)) return o;
  }
  return null;
}

export interface StrayGroup<T extends InstanceLike> {
  to: T;
  ids: string[];
}

/** Records already filed in a catch-all whose category names a sibling list,
 *  grouped by the list they belong in. What the inventory list turns into
 *  "12 items look like they belong in Teas". */
export function strayRecords<T extends InstanceLike>(
  records: ReadonlyArray<{ id: string; category: string | null | undefined }>,
  options: readonly T[],
): StrayGroup<T>[] {
  const byInstance = new Map<string, StrayGroup<T>>();
  for (const r of records) {
    const to = instanceForCategory(r.category, options);
    if (!to) continue;
    const g = byInstance.get(to.instance) ?? { to, ids: [] };
    g.ids.push(r.id);
    byInstance.set(to.instance, g);
  }
  return [...byInstance.values()].sort((a, b) => b.ids.length - a.ids.length);
}
