// A candidate that lands in a module's catch-all table with a category that
// NAMES one of the module's own lists goes to that list instead.
//
// The model recognised green tea as tea and said so, as an inventory category
// called "Teas", on a candidate routed to the base Inventory table, in a
// workspace that has a Teas list (2026-09-08). Twelve items went that way:
// tea, spices, baking supplies, each filed in the catch-all with a category
// spelling out where it should have gone. The rule is the platform's
// (@cobblr/platform-contract/instance-for-category); here it is applied to
// the scan menu, where the sibling lists are the same module's non-default
// entries.

import type { ScanMenuEntry } from "./matchmaker.js";
import { instanceForCategory } from "@cobblr/platform-contract/instance-for-category";

interface CandidateLike {
  module: string;
  instance: string | null;
  kind: string;
  label?: string;
  category?: string;
  category_is_new?: boolean;
}

/** Mutates in place, like the fills beside it. Only a candidate on a
 *  module's DEFAULT entry moves; one already in a named list is where the
 *  model put it on purpose. The category is dropped on the way: it was the
 *  list's name, and inside that list it says nothing. Returns how many moved,
 *  for the log. */
export function retargetByCategory(candidates: CandidateLike[], menu: readonly ScanMenuEntry[]): number {
  let moved = 0;
  for (const cand of candidates) {
    if (cand.instance) continue;
    if (!cand.category) continue;
    const siblings = menu
      .filter((e) => e.module === cand.module && e.instance)
      .map((e) => ({ instance: e.instance!, label: e.label, noun: e.noun, keywords: e.scan_keywords ?? null, entry: e }));
    const hit = instanceForCategory(cand.category, siblings);
    if (!hit) continue;
    cand.instance = hit.entry.instance;
    cand.kind = hit.entry.kind;
    cand.label = hit.entry.label;
    delete cand.category;
    delete cand.category_is_new;
    moved++;
  }
  return moved;
}
