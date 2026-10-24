// The one quantity figure: a number and its unit, read the same wherever it is
// shown. The server's units catalog and the web's formatter were two copies of
// this ("mirror of the server-side formatter so display is identical wherever it
// runs"), and the copies drifted: the server learned that "H" is a henry and
// "h" an hour, the web did not, so 3622.45 H read "hours" in the app and
// "henries" from the server (#7926, Trust #6). Both now call these; a property
// test holds every path to this one.

import { countWordsFor, wordForCount, type CountWords } from "@cobblr/platform-contract/plural";
import { quantityNumber } from "@cobblr/platform-contract/quantity-number";
import { MEASURE_UNITS } from "@cobblr/platform-contract/measure";

/** The parts of a unit a figure reads. Both the catalog's and the web's unit types fit it. */
export interface UnitLike {
  code: string;
  symbol: string;
  name: string;
  plural: string;
  category: string;
  /** Base-units-per-unit within the category; two units with one are interconvertible. */
  factor?: number | undefined;
}

/** The built-in canonical unit vocabulary: a stable `code`, the shorthand `symbol`, the singular
 *  `name` and the `plural`, grouped by `category`. */
export type UnitCategory =
  | "count"
  | "mass"
  | "length"
  | "area"
  | "volume"
  | "time"
  | "electrical"
  | "digital";

export interface UnitDef {
  code: string;
  symbol: string;
  name: string;
  plural: string;
  category: UnitCategory;
  /** How many of the category's BASE unit one of these is (mass→gram,
   *  length→metre, area→m², volume→litre, time→second, digital→MB). Two units
   *  in the same category that both carry a factor are interconvertible: a value
   *  in `from` becomes `value * from.factor / to.factor` in `to`. Omitted = not
   *  convertible (count units — a "pack" isn't a fixed number of "each"). */
  factor?: number;
}

export const BUILTIN_UNITS: UnitDef[] = [
  // count — deliberately NO factor (a pack/set/box isn't a fixed count).
  { code: "each", symbol: "ea", name: "each", plural: "each", category: "count" },
  { code: "piece", symbol: "pc", name: "piece", plural: "pieces", category: "count" },
  { code: "pair", symbol: "pr", name: "pair", plural: "pairs", category: "count" },
  { code: "pack", symbol: "pk", name: "pack", plural: "packs", category: "count" },
  { code: "set", symbol: "set", name: "set", plural: "sets", category: "count" },
  { code: "roll", symbol: "roll", name: "roll", plural: "rolls", category: "count" },
  { code: "sheet", symbol: "sht", name: "sheet", plural: "sheets", category: "count" },
  { code: "box", symbol: "box", name: "box", plural: "boxes", category: "count" },
  { code: "dozen", symbol: "dz", name: "dozen", plural: "dozen", category: "count" },
  // mass — base = gram
  { code: "milligram", symbol: "mg", name: "milligram", plural: "milligrams", category: "mass", factor: 0.001 },
  { code: "gram", symbol: "g", name: "gram", plural: "grams", category: "mass", factor: 1 },
  { code: "kilogram", symbol: "kg", name: "kilogram", plural: "kilograms", category: "mass", factor: 1000 },
  { code: "ounce", symbol: "oz", name: "ounce", plural: "ounces", category: "mass", factor: 28.349523125 },
  { code: "pound", symbol: "lb", name: "pound", plural: "pounds", category: "mass", factor: 453.59237 },
  // length — base = metre
  { code: "millimeter", symbol: "mm", name: "millimeter", plural: "millimeters", category: "length", factor: 0.001 },
  { code: "centimeter", symbol: "cm", name: "centimeter", plural: "centimeters", category: "length", factor: 0.01 },
  { code: "meter", symbol: "m", name: "meter", plural: "meters", category: "length", factor: 1 },
  { code: "inch", symbol: "in", name: "inch", plural: "inches", category: "length", factor: 0.0254 },
  { code: "foot", symbol: "ft", name: "foot", plural: "feet", category: "length", factor: 0.3048 },
  { code: "yard", symbol: "yd", name: "yard", plural: "yards", category: "length", factor: 0.9144 },
  // area — base = m²
  { code: "square-meter", symbol: "m²", name: "square meter", plural: "square meters", category: "area", factor: 1 },
  { code: "square-foot", symbol: "ft²", name: "square foot", plural: "square feet", category: "area", factor: 0.09290304 },
  // volume — base = litre
  { code: "milliliter", symbol: "ml", name: "milliliter", plural: "milliliters", category: "volume", factor: 0.001 },
  { code: "liter", symbol: "L", name: "liter", plural: "liters", category: "volume", factor: 1 },
  { code: "fluid-ounce", symbol: "fl oz", name: "fluid ounce", plural: "fluid ounces", category: "volume", factor: 0.0295735295625 },
  // time — base = second
  { code: "hour", symbol: "h", name: "hour", plural: "hours", category: "time", factor: 3600 },
  { code: "minute", symbol: "min", name: "minute", plural: "minutes", category: "time", factor: 60 },
  { code: "day", symbol: "d", name: "day", plural: "days", category: "time", factor: 86400 },
  // electrical: distinct dimensions, NOT interconvertible, so no factor. The
  // same codes a measured value carries ("4k7" is 4700 ohm), from the one list.
  // Its lengths (millimeter, inch) are the ones listed under length above.
  ...MEASURE_UNITS.filter((u) => u.category === "electrical").map((u) => ({ code: u.code, symbol: u.symbol, name: u.name, plural: u.plural, category: "electrical" as const })),
  // digital — base = MB
  { code: "megabyte", symbol: "MB", name: "megabyte", plural: "megabytes", category: "digital", factor: 1 },
  { code: "gigabyte", symbol: "GB", name: "gigabyte", plural: "gigabytes", category: "digital", factor: 1000 },
];

export type UnitDisplayMode = "symbol" | "name" | "both";

/** A raw unit string to its catalog entry: the symbol exactly first ("H" a henry, "h" an hour), then
 *  symbol, code, name or plural without regard to case. Null for text the vocabulary does not know,
 *  which renders as typed. */
export function resolveUnitIn<U extends UnitLike>(raw: string | null | undefined, units: readonly U[]): U | null {
  if (!raw) return null;
  const typed = raw.trim();
  const q = typed.toLowerCase();
  if (!q) return null;
  return (
    units.find((u) => u.symbol === typed) ??
    units.find((u) => u.symbol.toLowerCase() === q) ??
    units.find((u) => u.code.toLowerCase() === q) ??
    units.find((u) => u.name.toLowerCase() === q || u.plural.toLowerCase() === q) ??
    null
  );
}

/** A value from one unit into another, when both share a category and carry a factor. The
 *  floating-point noise of the ratio is trimmed (1000 * 0.001 is 1, not 1.0000000000000002). */
export function convertBetween(value: number, from: UnitLike | null, to: UnitLike | null): number | null {
  if (!Number.isFinite(value) || !from || !to || from.code === to.code) return null;
  if (from.category !== to.category) return null;
  if (from.factor == null || to.factor == null) return null;
  return parseFloat(((value * from.factor) / to.factor).toPrecision(12));
}

/** A quantity and its unit as a person reads it: whole numbers as they are, otherwise up to three
 *  decimals with no trailing zeros; the unit as its symbol, its word agreeing with the count, or both.
 *  A unit the vocabulary does not know still agrees with its count ("3 hanks"). `qty` may be null to
 *  label a unit with no number. */
export function formatQuantityIn(
  qty: number | null | undefined,
  raw: string | null | undefined,
  units: readonly UnitLike[],
  mode: UnitDisplayMode = "symbol",
  known: readonly CountWords[] = [],
): string {
  const n = qty == null || Number.isNaN(qty) ? null : qty;
  const numPart = n == null ? "" : quantityNumber(n);
  const def = resolveUnitIn(raw, units);
  if (!def) {
    const typed = (raw ?? "").trim();
    const word = typed && n != null ? wordForCount(n, countWordsFor(typed, known)) : typed;
    return [numPart, word].filter(Boolean).join(" ");
  }
  const word = n != null && Math.abs(n) === 1 ? def.name : def.plural;
  const unitPart = mode === "name" ? word : mode === "both" ? `${def.symbol} (${word})` : def.symbol;
  return [numPart, unitPart].filter(Boolean).join(" ");
}
