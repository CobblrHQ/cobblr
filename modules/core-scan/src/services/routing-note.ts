// The routing note: written by the matchmaker, re-read by the inbox.
//
// ONE file writes it and parses it. The composer and the parser used to live
// apart (matchmaker.ts wrote the prose, inbox.ts regexed it back out, and a
// test carried a THIRD copy of the regex "kept identical") - so a wording change
// in one place silently broke the other two. That happened: the phrasing was
// changed for the card, the parser was widened by hand, and the test went on
// asserting only the old wording, which meant the healer was untested for every
// note written from that day on.
//
// The note quotes the CATEGORY, and categories get re-labelled by later passes
// ("apparel" -> "Clothing"), so the stored prose can contradict the chip beside
// it. displayed() re-composes the quote on the way out. Keeping the composer and
// the parser together is what lets that be trusted.

import { categoryDisplay } from "@cobblr/platform-contract/category-reconcile";

/** What a no-AI routing note says when the fallback carried a category. */
export function routingNoteWithCategory(tableLabel: string, category: string): string {
  return `Filed into ${tableLabel} as “${categoryDisplay(category)}”. ${AI_HINT}`;
}

/** What it says when there was no category to file under. */
export function routingNoteBare(): string {
  return AI_HINT;
}

const AI_HINT = "Connect an AI provider for a sharper name and filled-in fields.";

/** Every lead this note has ever been written with. Old rows keep the old
 *  prose, so the parser has to recognise all of them; a wording change ADDS to
 *  this list and never removes from it. */
const LEADS = ["Filed into", "No specific table matched, so this went to"];

const NOTE_RE = new RegExp(`((?:${LEADS.join("|")}) .*? as )“([^”]+)”`);

/** Re-compose the quoted category with its current display label, so the note
 *  agrees with the chip. Idempotent; a note that carries no quote is untouched. */
export function displayed(notes: string): string {
  return notes.replace(NOTE_RE, (_m, lead: string, label: string) => `${lead}“${categoryDisplay(label)}”`);
}
