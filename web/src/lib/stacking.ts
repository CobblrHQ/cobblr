// Bottom-up numbering for storage that stacks.
//
// The house convention: **shelf 1 is the bottom shelf.** Shelf 5 is the top.
//
// It is a strong suggestion, not a rule. You choose at the moment you create
// the range, and you can drag any group into any order afterwards.
//
// The reason to have a convention at all is that without one you have to
// remember, per rack, which end you counted from — and you will get it wrong
// standing in front of the wrong rack. With one, shelf 1 is at floor level on
// every rack you own, so "shelf 1" is a position you can walk to rather than a
// label you have to look up.
//
// Numbered from the floor because the floor is the thing every rack shares.
// Add a shelf to the top and the numbering below it is untouched; number from
// the top and adding one renames every shelf in the rack.
//
// Deliberately NOT drawers. A toolbox's drawer 1 is the top one, near
// universally, and a convention that contradicts what people already do is
// worse than no convention at all.

/** Nouns for a thing whose siblings stack vertically off the floor. Kept short
 *  and unambiguous on purpose: "row" and "column" are left out because a row of
 *  bins on a bench is horizontal, and a convention that fires on the wrong
 *  shape teaches people to ignore it. */
export const STACKED_NOUNS = ["shelf", "shelves", "tier", "level", "rung", "layer"] as const;

/** Does this range prefix name something that stacks? Matches the last word so
 *  "Rack 1 Shelf" and "Garage Shelf" both count, and a leading qualifier never
 *  has to be anticipated. */
export function isStackedNoun(prefix: string): boolean {
  const last = prefix.trim().toLowerCase().split(/\s+/).pop() ?? "";
  return (STACKED_NOUNS as readonly string[]).includes(last);
}

/** Display order for a bottom-up group: highest number FIRST, so the list on
 *  screen reads the way the rack does — top shelf at the top, shelf 1 at the
 *  bottom. Numbering and drawing disagree on purpose; the numbers count up from
 *  the floor, the screen looks at the rack. */
export function bottomUpDisplayOrder<T>(ascendingByNumber: readonly T[]): T[] {
  return [...ascendingByNumber].reverse();
}
