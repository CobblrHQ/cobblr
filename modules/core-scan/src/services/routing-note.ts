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
import { fallbackHint, type AiFallback, type ProviderErrorReason } from "@cobblr/platform-contract/scan-fallback";

// ── The card's note, from the step that actually decided ─────────────────────
//
// Two steps can each have something to say about one item: the LOOKUP (a
// store's own label, nothing to look up; no catalog hit; a web guess held
// back) and the ROUTING (the matchmaker fell to the keyword floor, and why).
// The matchmaker used to overwrite whatever the lookup had written, so a
// store-internal code in a workspace whose AI errors read "The AI errored on
// this one, so it was matched by keywords" and lost "This is a store's own
// label": a note about a step that never applied to that code, over the one
// that did (#2907). The lookup's verdict is about the code and comes first;
// the routing's sentence is about where it went and follows, when there is
// one. Re-composing on a re-run must not stack routing sentences, so the
// known fallback sentences are stripped from the verdict before composing.

const FALLBACKS: AiFallback[] = ["no-provider", "background", "not-entitled", "provider-error", "no-answer"];
const REASONS: Array<ProviderErrorReason | undefined> = [undefined, "invalid_key", "quota", "model_unavailable", "unreachable", "unknown"];
const KNOWN_ROUTING_SENTENCES = [...new Set(FALLBACKS.flatMap((why) => REASONS.map((r) => fallbackHint(why, r))))];

/** `note` with every known routing (fallback) sentence removed, so what is
 *  left is the lookup's own words, or nothing. */
export function withoutRoutingSentences(note: string | null | undefined): string {
  let out = (note ?? "").trim();
  for (const sentence of KNOWN_ROUTING_SENTENCES) {
    while (out.includes(sentence)) out = out.replace(sentence, "").replace(/\s{2,}/g, " ").trim();
  }
  return out;
}

/** The card's note: the lookup's verdict first, the routing's sentence
 *  second, each its own sentence when both apply; whichever exists alone
 *  when only one does; null when neither. */
export function cardNote(lookupVerdict: string | null | undefined, routing: string | null | undefined): string | null {
  const verdict = withoutRoutingSentences(lookupVerdict);
  const r = (routing ?? "").trim();
  if (!verdict) return r || null;
  if (!r || verdict.includes(r)) return verdict;
  return `${verdict} ${r}`;
}

/** What a no-AI routing note says when the fallback carried a category. The
 *  hint names WHY the model was not the one routing (scan-fallback): "connect
 *  a provider" is only the sentence for having none. */
export function routingNoteWithCategory(tableLabel: string, category: string, why: AiFallback = "no-provider", reason?: ProviderErrorReason): string {
  return `Filed into ${tableLabel} as “${categoryDisplay(category)}”. ${fallbackHint(why, reason)}`;
}

/** What it says when there was no category to file under. */
export function routingNoteBare(why: AiFallback = "no-provider", reason?: ProviderErrorReason): string {
  return fallbackHint(why, reason);
}

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
