// A yes or a no that the rest of the answer contradicts.
//
//   "Is the inbox empty now?"  ->  "Yes, your scan inbox still has 1 item waiting."
//
// The facts in that reply were right and its first word was wrong (walk
// #9477). A person reads the first word: they stop at "Yes" and go on
// believing the receipt line was filed. Asking the model again costs a round
// and may not help, since what it found was right. So the opener goes: what
// is left is the model's own finding, said without a verdict that disagrees
// with it.
//
// Narrow on purpose. It fires only when the question asks whether something
// is empty or whether there is any of something, the reply opens with a bare
// yes or no, and the reply then states the opposite count. A reply that says
// both ("yes, nothing left except 1 line") is left alone.

import { isAQuestion } from "./utterance.js";

// ascii-only: an English yes/no opener and English count words; another language's answer is left exactly as the model wrote it
const OPENER = /^\s*(yes|yep|yeah|no|nope)\b[\s,.!:;–—-]*/i;
// ascii-only: English question shapes, as above
const ASKS_EMPTY = /\b(empty|cleared?|all (filed|done|gone|sorted)|nothing (left|waiting|in|on))\b/i;
// ascii-only: English question shapes, as above
const ASKS_ANY = /\b(is there|are there|do i (still )?have|does (it|the \w+) (still )?have|anything|anyone|any \w+ (left|waiting|in|on))\b/i;
// ascii-only: English count phrases, as above
const SAYS_SOME = /\b(still (has|have|holds|contains|shows)|([1-9]\d*|one|two|three|four|five|a few|some) (\w+ )?(items?|things?|lines?|records?|parts?|scans?|receipts?|entries|entry)\b(?! (were|was) (filed|removed|cleared)))/i;
// ascii-only: English count phrases, as above
const SAYS_NONE = /\b(is (now )?empty|are (now )?empty|nothing (left|waiting|remains|in|on)|no (more )?(items?|things?|lines?|records?|parts?|scans?|receipts?|entries)( left| waiting)?\b|zero (items?|lines?|records?))/i;

/** The reply with a contradicted opening yes or no taken off, or as it was. */
export function yesNoAgrees(question: string, reply: string): string {
  if (!isAQuestion(question)) return reply;
  const open = OPENER.exec(reply);
  if (!open) return reply;
  const rest = reply.slice(open[0].length);
  if (!rest.trim()) return reply;
  const yes = /^(yes|yep|yeah)$/i.test(open[1]!);
  const some = SAYS_SOME.test(rest);
  const none = SAYS_NONE.test(rest);
  if (some === none) return reply;
  const empty = ASKS_EMPTY.test(question);
  const any = !empty && ASKS_ANY.test(question);
  if (!empty && !any) return reply;
  // "Is it empty?" yes = none; "is there any?" yes = some.
  const saidSome = empty ? !yes : yes;
  if (saidSome === some) return reply;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
