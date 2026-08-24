// One value, or several.
//
// A view filter was equality-only: `filter.location_id = <one id>`. So "the
// things in the fridge OR the pantry" could not be expressed, which is exactly
// what a screen mounted between a fridge and a pantry needs to show.
//
// THE FAILURE MODE THIS REPLACES IS THE BAD DIRECTION. The native-column branch
// tested `typeof val === "string"` and fell through on anything else, so passing
// an array applied NO filter at all: the view showed everything rather than
// nothing, with no error anywhere. A panel meant to show one cupboard would have
// shown the whole kitchen, and the only clue would have been somebody noticing
// the count looked wrong.

/**
 * The values a filter should match, or null when there is nothing usable.
 *
 * Null is not "match everything" - callers must treat it as "this filter cannot
 * be applied" and say so, rather than dropping it. Dropping a filter widens a
 * result set, and widening silently is how a panel lies about what is in a
 * cupboard.
 */
export function filterValues(val: unknown): string[] | null {
  if (typeof val === "string") {
    const s = val.trim();
    return s ? [s] : null;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return [String(val)];
  }
  if (Array.isArray(val)) {
    const out = val
      .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
    // Deduped: a repeated id in a config is harmless but makes an IN list longer
    // than it needs to be, and a `[]` after cleaning means the author asked for
    // nothing rather than for everything.
    return out.length ? [...new Set(out)] : null;
  }
  return null;
}

/** True when the filter names more than one thing, so a caller can pick IN over
 *  a plain equality and keep using an index on the single-value path. */
export function isMulti(values: string[]): boolean {
  return values.length > 1;
}
