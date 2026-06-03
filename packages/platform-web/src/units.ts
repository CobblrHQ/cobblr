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
