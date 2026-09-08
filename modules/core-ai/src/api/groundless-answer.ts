// An answer about a specific thing, given without looking at it.
//
//   "who makes the X1 Carbon?"  ->  "Bambu Lab."  (no tool call, one round)
//
// True of the world, and not an answer about this workspace. The record here
// might be a different X1 Carbon, might carry a manufacturer nobody expects,
// might not exist at all. The model was not being careless: it recognised the
// name, so the answer felt like knowledge rather than a guess. That is exactly
// the failure the owner photographed on his phone in August - a confident
// paragraph about his printers that had never touched his printers.
//
// GROUNDING_RULES already say "anything about the user's own records comes
// from a tool call you just made, never from memory". The rule is right and
// the model agreed with it; it just did not notice the sentence applied. So
// this is the platform's answer rather than a longer prompt, the same shape as
// the argument guard: when the answer went out having read NOTHING, and the
// question named something this workspace could plausibly hold, hand it back
// once and let the model choose again with the omission named.
//
// Deliberately narrow, because a wrong nudge costs a round and a right one
// saves a wrong answer:
//   - it has to be a QUESTION. "Make me a location called Harbour Shelf" names
//     a thing and is an instruction, not a claim about one: the model answers
//     it by acting, and a model with no tool-calling answers it by writing the
//     JSON move the app parses into a proposal. Nudging that turned a
//     proposal into a paragraph (CI caught it, 2026-09-08). A model that
//     describes instead of acting is a different failure with a different
//     guard;
//   - a how-to, a capability question or a question about the product itself
//     is never about a record, whatever it capitalises;
//   - the question has to name something PARTICULAR: a model code (X1, PM240,
//     DCD777), a camel-cased name (CubePro, RailCore), or two capitalised
//     words together (Kossel Mini). A bare acronym is not enough - "what is
//     the difference between PLA and ABS" is a question about the world and
//     is answered correctly with no tool call at all, and a nudge there buys
//     a round of latency for nothing;
//   - it fires once per turn, and the nudge itself says that answering as
//     before is a fine outcome if the question really was not about the
//     workspace. A false positive is then one extra round, never a refusal.

import { isAQuestion, looksLikeAMove } from "./utterance.js";

/** Product/self references that being capitalised does not make a record. */
const NOT_A_RECORD = new Set([
  "cobblr", "cobb", "i", "i'm", "im", "ok", "okay", "yes", "no", "please", "thanks",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "today", "tomorrow", "yesterday",
]);

/** Questions about how to work the app, or about the app itself. */
const ABOUT_THE_APP =
  /^\s*(how (do|can|would|does|should)|where (do|can|should)|can (i|you|we)|could (i|you)|what can you|is there (a way|any way)|what is cobblr|what does this app|show me how|teach me|explain how)\b/i;

const bareWord = (w: string): string => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");

/** A word that names something in particular ON ITS OWN. */
function namesAThing(word: string): boolean {
  const bare = bareWord(word);
  if (bare.length < 2) return false;
  if (NOT_A_RECORD.has(bare.toLowerCase())) return false;
  // A model code: letters and digits together (x1, pm240, dcd777, e3d-v6).
  if (/[A-Za-z]/.test(bare) && /[0-9]/.test(bare)) return true;
  // A camel-cased name: CubePro, RailCore, PrusaSlicer.
  return /^[A-Z][a-z]+[A-Z]/.test(bare);
}

/** Capitalised mid-sentence: one half of a two-word name. */
function looksProper(word: string, index: number): boolean {
  const bare = bareWord(word);
  if (index === 0 || bare.length < 2) return false;
  if (NOT_A_RECORD.has(bare.toLowerCase())) return false;
  return /^[A-Z][A-Za-z'’-]+$/.test(bare);
}

/**
 * Does this message ask about something specific enough that answering it
 * without a tool call is answering from memory?
 */
export function namesSomethingSpecific(text: string): boolean {
  const t = text.trim();
  if (!t || ABOUT_THE_APP.test(t)) return false;
  if (!isAQuestion(t)) return false;
  const words = t.split(/\s+/);
  if (words.some((w) => namesAThing(w))) return true;
  // Two capitalised words together: "Kossel Mini", "Brass Widget", "Shelf B".
  return words.some((w, i) => i > 0 && looksProper(w, i) && looksProper(words[i + 1] ?? "", i + 1));
}

// MEASURED. The first wording ended "if the question genuinely was not about
// their records, answer as you just did and say what you are basing it on".
// Asked who makes a machine the workspace owns, the model took that door: it
// was nudged, considered the question general, and answered from memory again
// (bench 2026-09-08, rounds=2, reads=[]). An escape a model can take by
// deciding the question was not about the user is not a guard. This wording
// leaves no door, because the detector has already established that the
// question names something in particular - and looking costs one call.
export const GROUNDING_NUDGE =
  "(You answered that without looking. This workspace may hold something quite different from what you know " +
  "about that name: another model entirely, a maker nobody would guess, or no such record at all - so an answer " +
  "from memory is a guess wearing the clothes of a fact. Call search_records or list_records now and answer from " +
  "what comes back. If nothing matches, say so plainly - that is a good answer. Do not answer from general " +
  "knowledge again without saying, in the answer itself, that you did not find a record.)";

/** The nudge to hand back, or null to let the reply stand. */
export function groundingNudgeFor(userText: string, reply: string): string | null {
  if (!reply.trim() || looksLikeAMove(reply)) return null;
  return namesSomethingSpecific(userText) ? GROUNDING_NUDGE : null;
}
