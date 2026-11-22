// The order a page lists names in: the way a person counts and reads (#4115).
// The server side of the same order is name-order.ts (an ICU collation).
//
// A plain text sort put "Hex bolt M10" between "M1" and "M2" and "Écrou" after
// every plain letter: to a person a list of bolts runs M2, M8, M10, and É is an
// E. Numbers in a name compare by their value, accents and case only break a
// tie, in the person's own locale. A list the page holds whole sorts by it; a
// list the server pages is the server's to order (#9713), never re-sorted here.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Two names in the order a person reads them. A missing name sorts last. */
export function compareNames(a: string | null | undefined, b: string | null | undefined): number {
  if (a == null || a === "") return b == null || b === "" ? 0 : 1;
  if (b == null || b === "") return -1;
  return collator.compare(a, b);
}
