// Client-side unit formatting. The catalog (built-in + custom units +
// display mode) is fetched once from core-units; these pure helpers
// resolve a raw `unit` string to a catalog entry and render it as the
// shorthand symbol, the full word, or both. Mirror of the server-side
// units-catalog.ts formatter so display is identical wherever it runs.

import type { CountWords } from "@cobblr/platform-contract/plural";
import { convertBetween, formatQuantityIn, resolveUnitIn } from "@cobblr/platform-contract/unit-figure";
import type { PlatformUnitDef, UnitDisplayMode } from "./types";

/** Resolve a raw unit string to a catalog entry: the symbol exactly first ("H" a
 *  henry, "h" an hour), then without regard to case by symbol, code, name or
 *  plural. Null for free-text the vocabulary doesn't know, which renders as
 *  typed. The rule is the contract's one (unit-figure.ts), shared with the
 *  server's catalog, so the app reads what the server does. */
export function resolveUnit(raw: string | null | undefined, units: PlatformUnitDef[]): PlatformUnitDef | null {
  return resolveUnitIn(raw, units);
}

/** Convert a numeric value between two raw unit strings when they resolve to
 *  the same category and both carry a factor (e.g. "1000" g → kg = 1). Returns
 *  null when not convertible (different categories, count/free-text units, or
 *  an unknown unit) — the caller keeps the value as-is. */
export function convertQuantity(
  value: number,
  fromRaw: string | null | undefined,
  toRaw: string | null | undefined,
  units: PlatformUnitDef[],
): number | null {
  return convertBetween(value, resolveUnit(fromRaw, units), resolveUnit(toRaw, units));
}

/** Render a quantity + unit per the display mode, pluralising the full word
 *  by quantity ("1 gram" / "340 grams"). A unit the vocabulary does not
 *  know agrees with its count too, from `known` (a bundle's declared words)
 *  or the regular rules. `qty` may be null to label a unit without a number. */
export function formatQuantity(
  qty: number | null | undefined,
  raw: string | null | undefined,
  units: PlatformUnitDef[],
  mode: UnitDisplayMode = "symbol",
  known: readonly CountWords[] = [],
): string {
  return formatQuantityIn(qty, raw, units, mode, known);
}

/** Just the unit token (no quantity) per mode — for column headers / chips. */
export function formatUnit(
  raw: string | null | undefined,
  units: PlatformUnitDef[],
  mode: UnitDisplayMode = "symbol",
): string {
  const def = resolveUnit(raw, units);
  if (!def) return (raw ?? "").trim();
  if (mode === "name") return def.plural;
  if (mode === "both") return `${def.symbol} (${def.plural})`;
  return def.symbol;
}

/**
 * The unit to show BESIDE A QUANTITY, or "" when it would say nothing.
 *
 * A count unit repeats what the number already said: a list of countable
 * things became a column of "each", and a yarn workspace a column of
 * "skeins" (reported 2026-08-29). A MEASURED unit is the opposite — `750`
 * without `g` is not a quantity, it is a number.
 *
 * So the vocabulary decides, not a hardcoded list: anything in the `count`
 * category is dropped, anything measured is kept. Always the symbol ("g",
 * never "grams"), whatever the workspace's display mode is for other
 * surfaces — a row is the one place where the shortest true form wins.
 *
 * Free text the vocabulary cannot place is dropped too. It is nearly always
 * a count noun somebody typed ("skein", "spool"), which is the case this
 * exists for; a measured unit is in the catalog or is a custom unit that
 * declares its category, and both resolve.
 */
export function quantitySuffix(
  raw: string | null | undefined,
  units: PlatformUnitDef[],
): string {
  const def = resolveUnit(raw, units);
  if (!def || def.category === "count") return "";
  return def.symbol;
}

/** Whether an amount kept in this unit may be a fraction: 0.25 kg, 1.5 m.
 *  A counted unit (each, packs, a table's own "ball") takes whole numbers. A
 *  unit typed before the vocabulary has loaded may be either, so it is let
 *  through as measured: a fraction typed for a count is visible and fixed by
 *  the person, while a measured 0.25 rounded to 1 takes four times the stock
 *  without a word (#5962). */
export function isMeasuredUnit(raw: string | null | undefined, units: PlatformUnitDef[]): boolean {
  const q = (raw ?? "").trim().toLowerCase();
  if (!q || q === "each") return false;
  const def = resolveUnit(q, units);
  if (def) return def.category !== "count";
  return units.length === 0;
}

/** The workspace vocabulary as a consumption gauge reads it
 *  (@cobblr/platform-contract/consumption-gauge): which unit a string is,
 *  whether it is a measure, and conversion, all from this one catalog. */
export function unitLens(units: PlatformUnitDef[]): {
  code: (raw: string | null) => string | null;
  isMeasure: (raw: string | null) => boolean;
  convert: (value: number, from: string | null, to: string | null) => number | null;
} {
  return {
    code: (raw) => resolveUnit(raw, units)?.code ?? null,
    isMeasure: (raw) => {
      const u = resolveUnit(raw, units);
      return !!u && u.category !== "count" && u.factor != null;
    },
    convert: (value, from, to) => convertQuantity(value, from, to, units),
  };
}

/** The unit a person uses "some" of, for a quantity kept in a MEASURED unit:
 *  grams of a spool kept in kg, millilitres of a bottle kept in litres. Null
 *  for a counted unit (each, packs), free text, or a unit with no factor, where
 *  a step of one is the right move. A step of one in kg empties a spool, so a
 *  measured quantity is used by typing the amount, never by a fixed tap. */
const SMALL_CODE: Record<string, string> = { mass: "gram", length: "meter", volume: "milliliter" };
export function usedInUnit(raw: string | null | undefined, units: PlatformUnitDef[]): PlatformUnitDef | null {
  const u = resolveUnit(raw, units);
  if (!u || u.factor == null || u.category === "count") return null;
  if (!["mass", "length", "volume", "area"].includes(u.category)) return null;
  const small = units.find((x) => x.code === SMALL_CODE[u.category]);
  return small && small.factor != null && small.factor < u.factor ? small : u;
}
