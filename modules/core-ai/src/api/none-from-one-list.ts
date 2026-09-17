// "You don't have any black yarn", said after searching the Yarn list, to a
// workspace with four in Inventory.
//
//   "how much do I have of the black yarn"
//     -> list_records {kind: "yarn:item", q: "black"}   (nothing)
//     -> list_records {kind: "yarn:item"}               (one blue yarn)
//     -> "You don't have any black yarn recorded."
//
// A confident no about a person's own things, from one list. The write path
// had the same shape until the door was opened (#3090): an answer produced
// without the check that would have made it true. On the read path the check
// is the cross-kind search, and the model skipped it because the list it
// picked answered with an empty page, which reads like an answer.
//
// So a question answered "none" after reads that never looked across every
// kind is handed back once, naming the tool that does. A model that looked
// everywhere and found nothing keeps its no. An instruction is not a
// question and is left to the other guards.

import { isAQuestion, looksLikeAMove } from "./utterance.js";

/** The reply asserts absence: none, nothing, not found, no such thing. */
const SAYS_NONE =
  /\b(?:you (?:do not|don't|do not seem to|don't seem to) have (?:any|a)\b|there (?:is|are|isn't|aren't|is no|are no)\b[^.]{0,40}?\b(?:no|none|nothing)\b|there (?:is|are) no\b|none (?:recorded|listed|found|in)\b|nothing (?:called|named|matching|recorded|listed|found)\b|(?:i )?(?:couldn't|could not|didn't|did not|can't|cannot) find\b|not (?:recorded|listed|found) (?:in|anywhere)\b|no (?:records?|items?|entries|results?) (?:found|matching|for)\b)/i;

/** The read that looks across every list and kind. */
const EVERYWHERE = new Set(["search_records"]);

/** The nudge to hand back, or null to let the reply stand. */
export function noneFromOneList(userText: string, reply: string, reads: readonly string[]): string | null {
  if (!reply.trim() || looksLikeAMove(reply)) return null;
  if (!isAQuestion(userText)) return null;
  if (reads.length === 0 || reads.some((r) => EVERYWHERE.has(r))) return null;
  if (!SAYS_NONE.test(reply)) return null;
  return (
    "(You looked in one place and said there is none. A thing filed in another list is not in the one you " +
    "searched: call search_records with the same words, which looks across every list and kind, and answer " +
    "from what it finds. If that finds nothing either, say so then.)"
  );
}
