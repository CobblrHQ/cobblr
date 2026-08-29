// Client-side unit formatting. The catalog (built-in + custom units +
// display mode) is fetched once from core-units; these pure helpers
// resolve a raw `unit` string to a catalog entry and render it as the
// shorthand symbol, the full word, or both. Mirror of the server-side
// units-catalog.ts formatter so display is identical wherever it runs.

import type { PlatformUnitDef, UnitDisplayMode } from "./types";

/** Resolve a raw unit string to a catalog entry by symbol → code →
 *  name/plural (case-insensitive). Null for free-text the vocabulary
 *  doesn't know — it renders as typed. */
export function resolveUnit(
  raw: string | null | undefined,
  units: PlatformUnitDef[],
): PlatformUnitDef | null {
  if (!raw) return null;
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  return (
    units.find((u) => u.symbol.toLowerCase() === q) ??
    units.find((u) => u.code.toLowerCase() === q) ??
    units.find((u) => u.name.toLowerCase() === q || u.plural.toLowerCase() === q) ??
    null
  );
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
  if (!Number.isFinite(value)) return null;
  const from = resolveUnit(fromRaw, units);
  const to = resolveUnit(toRaw, units);
  if (!from || !to || from.code === to.code) return null;
  if (from.category !== to.category) return null;
  if (from.factor == null || to.factor == null) return null;
  const converted = (value * from.factor) / to.factor;
  // Trim FP noise (1000 * 0.001 / 1 = 1, but 1/3-style ratios shouldn't sprawl).
  return parseFloat(converted.toPrecision(12));
}

/** Render a quantity + unit per the display mode, pluralising the full
 *  word by quantity ("1 gram" / "340 grams"). Unknown units fall back to
 *  the raw string. `qty` may be null to label a unit without a number. */
export function formatQuantity(
  qty: number | null | undefined,
  raw: string | null | undefined,
  units: PlatformUnitDef[],
  mode: UnitDisplayMode = "symbol",
): string {
  const n = qty == null || Number.isNaN(qty) ? null : qty;
  // Clean number: integers as-is, otherwise trimmed to 3 decimals.
  const numPart = n == null ? "" : Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
  const def = resolveUnit(raw, units);
  if (!def) {
    return [numPart, (raw ?? "").trim()].filter(Boolean).join(" ");
  }
  const word = n === 1 ? def.name : def.plural;
  const unitPart =
    mode === "name" ? word : mode === "both" ? `${def.symbol} (${word})` : def.symbol;
  return [numPart, unitPart].filter(Boolean).join(" ");
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
