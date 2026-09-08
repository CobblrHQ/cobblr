// The model finds the action and then tells you about it.
//
//   "hide the manufacturer field on parts"
//     -> list_actions -> "You can hide it with the Edit field action."
//
// Nothing was hidden. The person asked for a change and got a description of
// the change, which is worse than a refusal: it reads like it happened.
//
// This is the biggest single failure left in the corpus, and it only became
// visible once the bench stopped serving these cases from cache. A fresh pass
// on 2026-09-08 put eight of nine misses in this shape: hide a field, make one
// required, group two headings, take a machine out of a container, turn a
// feature on. In six of them the model had ALREADY called list_actions - it
// went looking for what it could do, found it, and wrote about it.
//
// The prompt says to act. It has said so for weeks. So this is a guard, the
// same shape as the argument guard and the escort guard: hand the turn back
// once, naming the action the model itself named, and let it choose again.
//
// WHAT KEEPS IT SAFE, and each of these was measured against real cases that
// pass today:
//   - the user gave an INSTRUCTION. A question is answered with words, and
//     "what features can I enable" reads the same list for a different reason.
//   - the model went LOOKING: either the reply NAMES an action this workspace
//     has, or it called list_actions this turn. The name alone was the first
//     version and it caught only two of the eight, because a model describes
//     the OUTCOME rather than the registry's label - "you can make it required
//     by editing the field" never contains "Edit field". Having read the list
//     and then written prose is the same evidence one step earlier.
//   - the reply is prose, not the tool-less JSON move.
//   - it is a sentence, not a word. "help", "stop", "yes do it" are not
//     instructions to the workspace, and an answer to "help" that lists what
//     the workspace can do NAMES actions by design. Every miss in this shape
//     is four words or more; every short utterance in the corpus that answers
//     correctly in prose is three or fewer.
// It fires once, and the model may answer in words again - saying no is still
// allowed, it just has to be a choice rather than the default.
//
// MEASURED, both halves, fresh passes of the whole corpus (2026-09-08):
//   name only              154/159
//   name OR read the list  154/159
// The same total, a different five. Widening it fixed "make Purchase Date
// required" and "remove the Colour field from machines" - two more of the
// class - and cost "track a colour on every physical thing", where the model,
// pushed to act, proposed the neighbouring action instead of the right one.
//
// It ships wide, and the tie is broken on which failure costs the user more.
// A wrong proposal is a card they read and decline; a description that reads
// as though the change happened is invisible until they go looking for the
// change and it is not there. The three cases that pass by answering in prose
// because NOTHING does what was asked all held, and "restore last week's
// backup" is the proof: it was nudged, it read the list, and it correctly said
// nothing there does it. Revisit with a run, not an argument.

import { isAQuestion, looksLikeAMove } from "./utterance.js";

/** Action labels are user-facing prose ("Edit field", "Turn on a feature"), so
 *  a short one would match half the language. Below this they are ignored. */
const MIN_NAME = 5;

/** Below this it is a word, not an instruction. See the note above. */
const MIN_WORDS = 4;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The action the reply talks about, or null. */
export function actionNamedIn(reply: string, actionNames: Iterable<string>): string | null {
  const hay = reply.toLowerCase();
  let best: string | null = null;
  for (const raw of actionNames) {
    const name = raw.trim();
    if (name.length < MIN_NAME) continue;
    const needle = name.toLowerCase();
    if (!hay.includes(needle)) continue;
    // A whole phrase, not a fragment of a longer word.
    if (!new RegExp(`(^|[^a-z0-9])${escapeRe(needle)}([^a-z0-9]|$)`).test(hay)) continue;
    if (!best || name.length > best.length) best = name;
  }
  return best;
}

/** The nudge to hand back, or null to let the reply stand. */
export function describedInsteadOfActing(
  userText: string,
  reply: string,
  actionNames: Iterable<string>,
  sawActionList = false,
): string | null {
  if (!reply.trim() || looksLikeAMove(reply) || isAQuestion(userText)) return null;
  if (userText.trim().split(/\s+/).filter(Boolean).length < MIN_WORDS) return null;
  const named = actionNamedIn(reply, actionNames);
  if (!named && !sawActionList) return null;
  // The tail matters as much as the ask. "Make me an api token" and "restore
  // last week's backup" ALSO read the action list and answer in prose, and
  // they are right to: nothing there does it. So the way out is named first
  // and explicitly, and inventing an id is ruled out in the same sentence.
  const which = named
    ? `You described "${named}" instead of running it.`
    : `You read the list of actions and then wrote about what could be done, instead of doing it.`;
  return (
    `(${which} They asked you to do something, not to be told how it would be done - and nothing has changed ` +
    `in their workspace. If one of the actions you just read does what they asked, call invoke_action with it ` +
    `now, filling its arguments from what they said; they confirm every action before it runs, so proposing it ` +
    `is not doing it behind their back. If NONE of them does, say that plainly and stop - never invent an ` +
    `action id, and never pretend something happened. If you are only missing a value that only they can give, ` +
    `ask for that one value.)`
  );
}
