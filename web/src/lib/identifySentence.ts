// Why a card has no name yet, as the one rule the sentence follows.
//
// "No AI to read this photo yet (set it up)" is for a person with NO way to
// identify a photo here. It rendered for a person whose own connection reads
// photos (the 2026-09-13 review, #2845), because the flag behind it was a
// deployment switch. The flag is honest now (identify_available counts the
// person's own connection), and this is the only reader of it for the
// nameless sentence, so the card cannot say "set it up" over a working one.
//
// The identify step's own coded reason comes first when the row carries one
// (#2916): the server stamps identify_failure beside the note it wrote, so
// the card offers the remedy that fits (a name field for "the AI saw no
// single item", a retry for a provider that errored, the setup link for no
// provider) instead of one sentence for every reason at once.
import type { IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";

export type NamelessReason =
  /** Nothing here can identify a photo: the setup sentence. */
  | "no-identify"
  /** A shop's own code: nothing to look up. */
  | "store-code"
  /** The model looked and saw no one item to name. */
  | "no-item"
  /** A typed or scanned code no catalog knows; the web guess was left blank. */
  | "unresolved-code"
  /** The model was asked and failed, or ran without the person's own AI: a retry helps. */
  | "ai-failed"
  /** No coded reason on the row: the model did not answer. */
  | "did-not-answer";

export function namelessReason(
  status: { identify_available?: boolean } | null | undefined,
  storeCode: boolean,
  failure?: IdentifyFailure | null,
  /** The lookup held an uncorroborated web guess back and left the name
   *  blank (metadata held_reason): nothing found for the code (#2918). */
  unresolvedCode = false,
): NamelessReason {
  // Only a KNOWN "nothing here can identify a photo" earns the setup sentence;
  // an unknown status is not a reason to send someone to set up what they
  // may already have.
  if (storeCode) return "store-code";
  if (unresolvedCode) return "unresolved-code";
  if (status && status.identify_available === false) return "no-identify";
  if (failure?.code === "no_item") return "no-item";
  if (failure?.code === "ai_unavailable" && failure.ai === "no-provider") return "no-identify";
  if (failure?.code === "ai_unavailable" || failure?.code === "no_answer") return "ai-failed";
  return "did-not-answer";
}
