// "do it again" with nothing before it.
//
//   "do it again"   (the first thing said in the conversation)
//     -> list_records projects:project, list_actions
//     -> projects:copy-project "Birdhouse (Copy)"
//
// There was nothing to repeat, so the model picked something that sounds like
// "again" and proposed it: a copy of the only project in the workspace. The
// corpus asked it three times a night and it missed all three on 2026-10-18,
// 10-21 and 10-22, and passed on the nights between, so the prompt was never
// what held it (#7750).
//
// Nothing in the conversation is a fact code can read, so code answers: a
// retry said with no earlier turn is asked what to do, and no model is asked
// at all. The phrases are the retry rule's own keywords (basics-catalog.ts),
// so the no-AI floor and this guard cannot disagree about what "again" is.
//
// NARROW on purpose. The whole message must be the retry: "do it again for the
// blue one" says what to do, and goes to the model. With any earlier turn the
// model has something to repeat, and it is left alone.
import { BUILTIN_BASICS } from "../basics-catalog.js";
import { normalize } from "../basics-match.js";

/** Words that can ride along with a retry without saying what to do. */
const FILLER = new Set(["please", "that", "it", "can", "could", "you", "just", "again", "now"]);

const RETRY_PHRASES = (BUILTIN_BASICS.find((r) => r.key === "retry")?.keywords ?? []).map((k) => normalize(k).split(" "));

export const NOTHING_TO_REPEAT_REPLY =
  "There's nothing earlier in this conversation for me to do again. What would you like me to do?";

/** The message is only a retry: one of the phrases, plus filler at most. */
export function isOnlyARetry(message: string): boolean {
  const words = normalize(message).split(" ").filter(Boolean);
  return RETRY_PHRASES.some((phrase) => {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((w, j) => words[i + j] === w)) {
        return [...words.slice(0, i), ...words.slice(i + phrase.length)].every((w) => FILLER.has(w));
      }
    }
    return false;
  });
}

/** The reply when the newest message asks to repeat and nothing came before
 *  it, else null. `messages` is the conversation as the turn received it. */
export function nothingToRepeat(messages: ReadonlyArray<{ role: string; content: string }>): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;
  if (messages.length > 1) return null;
  return isOnlyARetry(last.content) ? NOTHING_TO_REPEAT_REPLY : null;
}
