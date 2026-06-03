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
}

export const BUILTIN_UNITS: UnitDef[] = [
  // count
  { code: "each", symbol: "ea", name: "each", plural: "each", category: "count" },
  { code: "piece", symbol: "pc", name: "piece", plural: "pieces", category: "count" },
  { code: "pair", symbol: "pr", name: "pair", plural: "pairs", category: "count" },
  { code: "pack", symbol: "pk", name: "pack", plural: "packs", category: "count" },
  { code: "set", symbol: "set", name: "set", plural: "sets", category: "count" },
  { code: "roll", symbol: "roll", name: "roll", plural: "rolls", category: "count" },
  { code: "sheet", symbol: "sht", name: "sheet", plural: "sheets", category: "count" },
  { code: "box", symbol: "box", name: "box", plural: "boxes", category: "count" },
  { code: "dozen", symbol: "dz", name: "dozen", plural: "dozen", category: "count" },
  // mass (metric-first, matches the platform's metric default)
  { code: "milligram", symbol: "mg", name: "milligram", plural: "milligrams", category: "mass" },
  { code: "gram", symbol: "g", name: "gram", plural: "grams", category: "mass" },
  { code: "kilogram", symbol: "kg", name: "kilogram", plural: "kilograms", category: "mass" },
  { code: "ounce", symbol: "oz", name: "ounce", plural: "ounces", category: "mass" },
  { code: "pound", symbol: "lb", name: "pound", plural: "pounds", category: "mass" },
  // length
  { code: "millimeter", symbol: "mm", name: "millimeter", plural: "millimeters", category: "length" },
  { code: "centimeter", symbol: "cm", name: "centimeter", plural: "centimeters", category: "length" },
  { code: "meter", symbol: "m", name: "meter", plural: "meters", category: "length" },
  { code: "inch", symbol: "in", name: "inch", plural: "inches", category: "length" },
  { code: "foot", symbol: "ft", name: "foot", plural: "feet", category: "length" },
  { code: "yard", symbol: "yd", name: "yard", plural: "yards", category: "length" },
  // area
  { code: "square-meter", symbol: "m²", name: "square meter", plural: "square meters", category: "area" },
  { code: "square-foot", symbol: "ft²", name: "square foot", plural: "square feet", category: "area" },
  // volume
  { code: "milliliter", symbol: "mL", name: "milliliter", plural: "milliliters", category: "volume" },
  { code: "liter", symbol: "L", name: "liter", plural: "liters", category: "volume" },
  { code: "fluid-ounce", symbol: "fl oz", name: "fluid ounce", plural: "fluid ounces", category: "volume" },
  // time
  { code: "hour", symbol: "h", name: "hour", plural: "hours", category: "time" },
  { code: "minute", symbol: "min", name: "minute", plural: "minutes", category: "time" },
  { code: "day", symbol: "d", name: "day", plural: "days", category: "time" },
  // electrical
  { code: "amp", symbol: "A", name: "amp", plural: "amps", category: "electrical" },
  { code: "volt", symbol: "V", name: "volt", plural: "volts", category: "electrical" },
  { code: "watt", symbol: "W", name: "watt", plural: "watts", category: "electrical" },
  // digital
  { code: "megabyte", symbol: "MB", name: "megabyte", plural: "megabytes", category: "digital" },
  { code: "gigabyte", symbol: "GB", name: "gigabyte", plural: "gigabytes", category: "digital" },
];

/** How a quantity+unit is rendered: shorthand symbol, full word, or both. */
export type UnitDisplayMode = "symbol" | "name" | "both";
export const DEFAULT_DISPLAY_MODE: UnitDisplayMode = "symbol";

/** Resolve a raw unit string to a catalog entry. Matches symbol → code →
 *  name/plural, case-insensitive, trimmed. Returns null for free-text the
 *  vocabulary doesn't know (it'll render as-is). The `extra` list lets the
 *  caller fold in a workspace's custom units. */
export function resolveUnit(
  raw: string | null | undefined,
  extra: UnitDef[] = [],
): UnitDef | null {
  if (!raw) return null;
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  const all = [...BUILTIN_UNITS, ...extra];
  return (
    all.find((u) => u.symbol.toLowerCase() === q) ??
    all.find((u) => u.code.toLowerCase() === q) ??
    all.find((u) => u.name.toLowerCase() === q || u.plural.toLowerCase() === q) ??
    null
  );
}

/** Render a quantity + unit per the display mode. Pluralises the full word
 *  by the quantity ("1 gram" / "340 grams"). Unknown units fall back to the
 *  raw string. `qty` may be omitted (label a unit without a number). */
export function formatQuantity(
  qty: number | null | undefined,
  raw: string | null | undefined,
  mode: UnitDisplayMode = DEFAULT_DISPLAY_MODE,
  extra: UnitDef[] = [],
): string {
  const n = qty == null || Number.isNaN(qty) ? null : qty;
  const def = resolveUnit(raw, extra);
  const numPart =
    n == null ? "" : Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
  if (!def) {
    // free-text unit: just join the number and whatever they typed
    const u = (raw ?? "").trim();
    return [numPart, u].filter(Boolean).join(" ");
  }
  const word = n === 1 ? def.name : def.plural;
  let unitPart: string;
  if (mode === "name") unitPart = word;
  else if (mode === "both") unitPart = `${def.symbol} (${word})`;
  else unitPart = def.symbol;
  return [numPart, unitPart].filter(Boolean).join(" ");
}
