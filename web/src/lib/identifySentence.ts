// Why a card has no name yet, and what it says: the contract's one map from
// a recorded reason to its words (@cobblr/platform-contract/scan-nameless,
// #4933). This file only adapts it for the phone row's remedy line.
//
// The identify step's own coded reason comes first when the row carries one
// (#2916), and a row that carries none says "Not named yet", never that the
// AI failed: a failure the record does not hold is not one to report.
import { headingSaysItAll, namelessReason, namelessWords, type NamelessReason } from "@cobblr/platform-contract/scan-nameless";
import type { IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";

export { headingSaysItAll, namelessReason, type NamelessReason };

/** The phone row's line under a nameless photo, with its button, or
 *  nothing: the contract's remedy for the reason. */
export function namelessRemedy(why: NamelessReason, failure: IdentifyFailure | null | undefined): { text: string; recovery: "retry" | "connect" } | null {
  return namelessWords(why, { noun: "item", failure }).remedy;
}
