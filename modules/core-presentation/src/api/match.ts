// Turning what a person SAID into the sections they meant.
//
// The matcher itself moved to the contract (@cobblr/platform-contract/said-names)
// when the kernel's field actions needed the same judgement: two copies would be
// two answers to "did they mean this one?", and they would drift the day one of
// them learned something. What stays here is the nav-shaped signature.

import { matchByLabel, splitNames } from "@cobblr/platform-contract/said-names";

export { splitNames };

/** Match a said name to a nav entry. */
export function matchEntry<T extends { label: string; id: string }>(
  said: string,
  entries: readonly T[],
): T | { ambiguous: T[] } | null {
  return matchByLabel(said, entries);
}
