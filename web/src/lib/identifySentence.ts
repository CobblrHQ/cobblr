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
import { identifyFailureWords, identifyNeverTried, type IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";

export type NamelessReason =
  /** A receipt whose lines could not be read: Read again, not a name (#3581). */
  | "receipt-unread"
  /** Nothing here can identify a photo: the setup sentence. */
  | "no-identify"
  /** A shop's own code: nothing to look up. */
  | "classified-code"
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
  /** A code the server classified as one no catalog looks up (a store's own
   *  label, an Amazon FNSKU): the contract's classifiedCodeOf. */
  classifiedCode: boolean,
  failure?: IdentifyFailure | null,
  /** The lookup held an uncorroborated web guess back and left the name
   *  blank (metadata held_reason): nothing found for the code (#2918). */
  unresolvedCode = false,
  /** The contract's scanReceiptReadFailed: outranks every other reason. */
  receiptUnread = false,
): NamelessReason {
  if (receiptUnread) return "receipt-unread";
  // Only a KNOWN "nothing here can identify a photo" earns the setup sentence;
  // an unknown status is not a reason to send someone to set up what they
  // may already have.
  if (classifiedCode) return "classified-code";
  if (unresolvedCode) return "unresolved-code";
  if (status && status.identify_available === false) return "no-identify";
  if (failure?.code === "no_item") return "no-item";
  if (failure && identifyNeverTried(failure)) return "no-identify";
  if (failure?.code === "ai_unavailable" || failure?.code === "no_answer") return "ai-failed";
  return "did-not-answer";
}

/** The phone row's line under a nameless photo, beside the note that is the
 *  reason: the remedy the contract names, with its button, or nothing.
 *
 *  Nothing when nothing tried. A workspace with no AI read two verdicts at
 *  once, "no AI provider is connected" and "The AI could not read this one"
 *  with a Retry that did the same nothing again (#3233): "we did not try"
 *  rendered as "we tried and failed". The note is the one sentence there,
 *  and the Connect AI line above the list is the door. Nothing either when
 *  the model looked and saw no one item, or a code no catalog knows: the
 *  sentence is the verdict, and a retry would look again at the same thing.
 *  Otherwise the button is the contract's (identifyFailureWords): connect
 *  when the connection itself is the problem, retry when asking again can
 *  answer, with the contract's remedy as the words beside it. */
export function namelessRemedy(why: NamelessReason, failure: IdentifyFailure | null | undefined): { text: string; recovery: "retry" | "connect" } | null {
  if (why !== "ai-failed" && why !== "did-not-answer") return null;
  if (!failure) return { text: "The AI could not read this one.", recovery: "retry" };
  const words = identifyFailureWords(failure);
  if (words.connect) return { text: words.detail, recovery: "connect" };
  if (words.retry) return { text: words.detail, recovery: "retry" };
  return null;
}

/** Whether the nameless card's heading already says the whole thing, so
 *  the note need not repeat it in amber under it (#3322: the desk card read
 *  "No AI to read this photo yet (set it up)" over "Couldn't identify this
 *  photo: no AI provider is connected", one fact twice, the second in
 *  warning colour). No AI, and a store's own code: the heading names the
 *  cause and the remedy. Every other reason keeps its note, which carries
 *  something the heading does not (the held guess, which AI failed and
 *  how, that the model saw no one item). */
export function headingSaysItAll(why: NamelessReason): boolean {
  return why === "no-identify" || why === "classified-code" || why === "receipt-unread";
}
