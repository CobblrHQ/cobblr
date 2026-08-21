/** Split a provider's model list into the ones worth offering first and the rest.
 *
 *  WHY REORDER AND NEVER FILTER: a provider's list is not curated for us. Google AI
 *  Studio reports 51 models and 36 of them are video, music, speech, embedding or
 *  robotics models that cannot answer a chat prompt at all. Dropping them would be
 *  the obvious move and is the wrong one: this heuristic reads NAMES, and a name is
 *  not a contract. The day a provider ships a good model whose id happens to contain
 *  "live" or "image", hiding it makes a working model unreachable with no way for the
 *  user to say otherwise. Demoting it costs a scroll.
 *
 *  So `others` is not junk, it is "we could not tell". Both groups render. */

/** Wrong modality or wrong task: these do not take a prompt and return text. */
const NOT_CHAT = [
  "tts",
  "audio",
  "embedding",
  "image",
  "veo", // video
  "lyria", // music
  "nano-banana", // image
  "live",
  "realtime",
  "robotics",
  "computer-use",
];

/** Attributed-QA endpoint: a different request shape, not a chat model. */
const NOT_CHAT_EXACT = ["aqa"];

export function isLikelyChatModel(id: string): boolean {
  const name = id.replace(/^models\//, "").toLowerCase();
  if (NOT_CHAT_EXACT.includes(name)) return false;
  return !NOT_CHAT.some((bad) => name.includes(bad));
}

export interface ModelGroups {
  /** Text-in, text-out. Offered first. */
  suggested: string[];
  /** Everything else, in the provider's own order. Never hidden. */
  others: string[];
}

export function groupModels(ids: string[]): ModelGroups {
  const suggested: string[] = [];
  const others: string[] = [];
  for (const id of ids) (isLikelyChatModel(id) ? suggested : others).push(id);
  return { suggested, others };
}

/** The id a provider reports can carry a namespace its own chat endpoint also
 *  accepts without one (Google reports `models/x`, and answers to both). Strip it
 *  for display so a picked model reads the same as the default named on the field. */
export function displayModel(id: string): string {
  return id.replace(/^models\//, "");
}
