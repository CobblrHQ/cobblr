// Editing one thing about a collection must not silently change another.
//
// An instance's override config is a shared blob. A bundle writes the keys that
// say what the collection IS (`item_noun`, `qty_unit`, `parent`, `stock_latched`)
// and the presentation form writes the keys that say how it LOOKS (`group_label`,
// `presents_as_top_level`). The column is written wholesale, and the route's own
// comment said "callers read-modify-write it" - which is a rule nothing enforced,
// so a form that rebuilt the blob from scratch dropped every key it had never
// heard of.
//
// What that costs, reported 2026-09-03: a Bookshelf whose "+ New book" button
// went back to reading "+ New record". Nothing failed; the word for the thing
// inside just stopped existing, and the page fell back to the module's internal
// noun. Renaming a collection is not consent to forget what it holds.
//
// So the door merges. A caller sends the keys it owns and cannot touch the rest,
// and an explicit null still means "remove this key" so clearing a setting is
// still expressible. Absent means untouched; null means gone.

/**
 * The stored config, updated by a caller's patch.
 *
 * `patch` absent entirely leaves the config exactly as it was. A key set to
 * null is removed; any other value is written.
 */
export function mergeOverrideConfig(
  stored: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(stored ?? {}) };
  if (!patch) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * A derived noun, written only into a gap.
 *
 * Seeding an instance used to skip the whole row when one already existed, so a
 * collection whose override had been created for anything else (an icon, a nav
 * position) never got a noun and its pages read the module's internal word
 * forever. That is the state the reported Bookshelf was actually in.
 *
 * Fill if absent; never overwrite a word somebody chose. Returns the SAME
 * object when there was nothing to do, so a caller can skip the write.
 */
export function fillItemNounIfAbsent(
  existing: Record<string, unknown>,
  derived: { itemNoun: string; itemNounPlural: string },
): Record<string, unknown> {
  const current = existing.item_noun;
  if (typeof current === "string" && current.trim()) return existing;
  return { ...existing, item_noun: derived.itemNoun, item_noun_plural: derived.itemNounPlural };
}
