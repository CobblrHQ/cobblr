// Whether anything changed is said from the turn's own count (#4115, retries).
//
// At Auto, "set the bolts to 40" ran its update, and then the provider turned
// the next call away. The failure sentence, written before anyone knew what
// the turn did, ended "Nothing was changed. Try again": the person was told a
// change they could see had not happened, had no undo for it, and asking
// again made it twice ("add 3" became 6). A turn cut by its time limit or a
// restart said the same over changes the ledger held.
//
// So no sentence in this module says it by hand (lint:nothing-changed-from-the-count).
// Every way a turn ends passes through here with how many changes the turn
// made, and this is the one place that says "Nothing was changed": only when
// that count is zero. Above zero, any such claim in what reaches the person
// is taken out, and a failure says what was kept instead.

import { countOf } from "@cobblr/platform-contract/plural";

const NOTHING_CHANGED = "Nothing was changed."; // sentence-moved-here: the one place a turn says it, from its count of changes
const CLAIM = /\s*(?:,\s*)?(?:and\s+|so\s+)?nothing (?:was|has been|is) changed(?: on your behalf)?(?:\s*[-:,]\s*ask again)?[.!]?/gi;
const TRY_AGAIN = /\s*(?:Please\s+)?(?:try|ask)\s+(?:asking\s+)?again\b[^.]*\./gi;

function kept(n: number, where: string): string {
  return n === 1
    ? `One change it made before stopping is kept, ${where}.`
    : `${countOf(n, "change")} it made before stopping are kept, ${where.replace(/\bits undo\b/, "their undo")}.`;
}

const sentence = (s: string): string => s.trim().replace(/[.!]*$/, ".").replace(/^\.$/, "");

/** `text` with any "nothing was changed" taken out. */
export function withoutChangeClaim(text: string): string {
  return text.replace(CLAIM, "").replace(/\s{2,}/g, " ").trim();
}

/** What a turn says, given how many changes it made.
 *
 *  - `failed`: the turn did not finish what was asked. With no changes the
 *    words end "Nothing was changed."; with some, the claim and any bare "try
 *    again" (asking again does the done part twice) are taken out, and what
 *    was kept is said, with `where` its undo is.
 *  - otherwise: with changes, any claim that nothing changed is taken out;
 *    with none, the words are left as they are. */
export function saidWithChanges(text: string, changes: number, opts: { failed?: boolean; where?: string } = {}): string {
  const plain = withoutChangeClaim(text);
  if (!opts.failed) return changes > 0 ? plain : text;
  if (changes <= 0) return [sentence(plain), NOTHING_CHANGED].filter(Boolean).join(" ");
  const why = sentence(plain.replace(TRY_AGAIN, ""));
  return [why, kept(changes, opts.where ?? "shown above, with its undo"), "Check it before asking for the rest, so nothing is done twice."].filter(Boolean).join(" ");
}

/** A finished turn's answer, held to its count: its `text`, and a refusal's
 *  `message`, pass through saidWithChanges. */
export function answerWithChanges<T>(answer: T, changes: number): T {
  if (!answer || typeof answer !== "object") return answer;
  const a = answer as Record<string, unknown>;
  return {
    ...a,
    ...(typeof a.text === "string" ? { text: saidWithChanges(a.text, changes) } : {}),
  } as T;
}
