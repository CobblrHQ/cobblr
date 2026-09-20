// The two scanner cards at the top of the dashboard, and the one rule that keeps
// them from contradicting each other.
//
// A fresh workspace with three scans that fit uninstalled bundles used to say
// the same thing three times in three voices: "3 scanned items without a home,
// put them away", a card of install chips ("Groceries · 2"), and the scanner
// lane further down ("2 look like Groceries, create it & file all 2", with the
// person's own photos). Two of the three offered the same one-tap install, and
// the nag counted the very scans its neighbour was offering to file (#3298).
//
// So: the scanner lane owns the install; the suggestions card is a pointer to
// it; the put-away nag counts only the scans nothing else on the screen is
// already offering a home.

import type { QuickstartSuggestion } from "./api";

export interface PutAwayInputs {
  unfiled: number;
  ready: number;
  failedReads: number;
  /** Scans another card on the same screen offers to file (the sum of the
   *  bundle suggestions' counts). Zero when there is no such card. */
  offeredElsewhere: number;
}

/** The sentence parts of the put-away card, or [] when it has nothing to say.
 *  Clamped at zero: the two counts come from two queries that refresh on
 *  their own clocks, so a moment of "3 offered, 2 unfiled" must read as
 *  nothing rather than as minus one. */
export function putAwayParts(i: PutAwayInputs): string[] {
  const unfiled = Math.max(0, i.unfiled - Math.max(0, i.offeredElsewhere));
  const parts: string[] = [];
  if (unfiled > 0) parts.push(`${unfiled} scanned item${unfiled === 1 ? "" : "s"} without a home`);
  if (i.ready > 0) parts.push(`${i.ready} ready to put away`);
  if (i.failedReads > 0) parts.push(`${i.failedReads} receipt${i.failedReads === 1 ? "" : "s"} that couldn't be read`);
  return parts;
}

export interface SuggestionsPointer {
  /** Scans the suggestions account for, in total. */
  count: number;
  /** "Groceries and Bookshelf" / "Groceries, Bookshelf and 2 other tables". */
  tables: string;
  sentence: string;
}

/** One sentence for however many suggestions there are, so the card is the
 *  same height at one and at forty and never becomes a second set of install
 *  buttons. */
export function suggestionsPointer(suggestions: readonly Pick<QuickstartSuggestion, "bundle_name" | "count">[]): SuggestionsPointer | null {
  if (suggestions.length === 0) return null;
  const count = suggestions.reduce((n, s) => n + s.count, 0);
  const names = suggestions.map((s) => s.bundle_name);
  const shown = names.slice(0, 2);
  const rest = names.length - shown.length;
  const tables =
    rest > 0
      ? `${shown.join(", ")} and ${rest} other table${rest === 1 ? "" : "s"}`
      : shown.join(" and ");
  const scans = `${count} scan${count === 1 ? "" : "s"}`;
  return { count, tables, sentence: `${scans} ${count === 1 ? "fits" : "fit"} ${tables}. Create ${names.length === 1 ? "it" : "them"} from your scanner queue below.` };
}
