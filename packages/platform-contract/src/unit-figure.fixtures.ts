// The sweep every path that prints a quantity is held to: the same seeded
// quantities, every spelling of every built-in unit, free-text units, and the
// three display modes. The paths (the server's catalog, the web's formatter)
// each run it against the one function in unit-figure.ts.

import { BUILTIN_UNITS, type UnitDisplayMode } from "@cobblr/platform-contract/unit-figure";

export const MODES: UnitDisplayMode[] = ["symbol", "name", "both"];

export const spellings = (u: { symbol: string; code: string; name: string; plural: string }): string[] =>
  [u.symbol, u.code, u.name, u.plural, u.symbol.toUpperCase(), u.name.toUpperCase(), ` ${u.symbol} `];

export const SWEEP_UNITS: Array<string | null> = [...BUILTIN_UNITS.flatMap(spellings), "hank", "cone", "boxes", "", null];

/** Seeded: the same sweep every run. Quantities are whole and have up to five decimals. */
export function sweep(count = 4000, seed = 20261022): Array<{ qty: number; unit: string | null }> {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: count }, () => ({
    qty: Math.round(next() * 1e6) / [1, 10, 100, 1000, 10_000, 100_000][Math.floor(next() * 6)]!,
    unit: SWEEP_UNITS[Math.floor(next() * SWEEP_UNITS.length)]!,
  }));
}
