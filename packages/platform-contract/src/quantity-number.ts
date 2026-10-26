// A quantity's number as a person reads it: whole as it is, otherwise up to `digits`
// decimals with no trailing zeros. The one rule; every screen, export and sentence
// that prints a quantity's number calls it, so 1.5 is 1.5 everywhere (#7926).
//
// plural.ts (quantityWithUnit) calls it too. Both are mirrored into the edge bridge
// (its production and laser sets), where the sync script rewrites the subpath import to
// the mirrored sibling.

export function quantityNumber(n: number, digits = 3): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(digits)));
}
