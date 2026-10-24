// The built-in canonical unit vocabulary. Each unit has a stable `code`
// (the canonical identity), a `symbol` (the shorthand — "g"), a `name`
// (the full word, singular — "gram") and `plural` ("grams"). A `category`
// groups them for the picker.
//
// Why a canonical vocabulary at all: a free-text `unit` field means "g"
// in one place and "grams" in another never correlate, and you can't
// offer a shorthand-vs-full-word display toggle (there's nothing to
// switch between). Resolving a stored value to a catalog entry gives both
// — one identity, two renderable forms.
//
// Storage stays free-text + backward compatible: the `unit` field keeps
// holding whatever string it holds ("each", "g", "grams"); the catalog is
// a *display + input aid*. `resolveUnit()` matches a raw value to an entry
// by symbol → code → name/plural (case-insensitive); an unmatched value
// renders as-is. So existing data needs no migration.

import type { CountWords } from "@cobblr/platform-contract/plural";
import { convertBetween, formatQuantityIn, resolveUnitIn } from "@cobblr/platform-contract/unit-figure";

// The vocabulary itself is the contract's (unit-figure.ts), so the server's
// catalog and the web's formatter read one list as well as one rule.
export { BUILTIN_UNITS, type UnitCategory, type UnitDef } from "@cobblr/platform-contract/unit-figure";
import { BUILTIN_UNITS, type UnitDef } from "@cobblr/platform-contract/unit-figure";

/** Convert `value` from one unit to another when they share a category and both
 *  define a factor; returns null when not convertible (different categories,
 *  count units, free-text). The caller decides what to do with null. The one
 *  rule is the contract's (unit-figure.ts), so the app reads what the server does. */
export function convertQuantity(value: number, from: UnitDef | null, to: UnitDef | null): number | null {
  return convertBetween(value, from, to);
}

/** How a quantity+unit is rendered: shorthand symbol, full word, or both. */
export type UnitDisplayMode = "symbol" | "name" | "both";
export const DEFAULT_DISPLAY_MODE: UnitDisplayMode = "symbol";

/** Resolve a raw unit string to a catalog entry (the contract's rule: the symbol
 *  exactly first, then without regard to case). The `extra` list lets the caller
 *  fold in a workspace's custom units. */
export function resolveUnit(raw: string | null | undefined, extra: UnitDef[] = []): UnitDef | null {
  return resolveUnitIn(raw, [...BUILTIN_UNITS, ...extra]);
}

/** Render a quantity + unit per the display mode. Pluralises the full word
 *  by the quantity ("1 gram" / "340 grams"). Unknown units fall back to the
 *  raw string. `qty` may be omitted (label a unit without a number). */
export function formatQuantity(
  qty: number | null | undefined,
  raw: string | null | undefined,
  mode: UnitDisplayMode = DEFAULT_DISPLAY_MODE,
  extra: UnitDef[] = [],
  known: readonly CountWords[] = [],
): string {
  return formatQuantityIn(qty, raw, [...BUILTIN_UNITS, ...extra], mode, known);
}
