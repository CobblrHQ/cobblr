// A quantity's number as a person reads it: whole as it is, otherwise up to `digits`
// decimals with no trailing zeros. The one rule; every screen, export and sentence
// that prints a quantity's number calls it, so 1.5 is 1.5 everywhere (#7926).
//
// Its own file, not plural.ts: plural.ts is mirrored into the edge bridge, and a change
// to a mirrored file merges only with a bridge repin. plural.ts keeps its inline copy of
// this rule (quantityWithUnit) until a repin folds it in.

export function quantityNumber(n: number, digits = 3): string {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(digits)));
}
