// Why a scan was routed by keywords instead of by the model, and what to say.
//
// The matchmaker swallowed the router's error and fell to the keyword floor,
// and the note it wrote was the same whatever had happened: "Matched by
// keywords (no AI). Connect an AI provider..." A person with a working
// personal connection read that under every fresh scan, because the ingest
// step had run without them and the connection serves only their own calls
// (the 2026-09-13 review, #2846). The router's answer is one of five things,
// and each is a different sentence; this is the one place that holds them,
// for the server's note and the card's chip alike. Which answer a refusal IS
// comes from the router's code (ai-refusal.ts), never from its prose.
// Buildless subpath: no runtime import of a sibling.

export type AiFallback =
  /** No provider anywhere for this workspace: connecting one is the remedy. */
  | "no-provider"
  /** The step ran with no person to route through, and the workspace has no
   *  provider of its own; the person's connection would have served. */
  | "background"
  /** A provider exists but the plan's allowance refused the call. */
  | "not-entitled"
  /** The provider was asked and failed. */
  | "provider-error"
  /** Asked, and no usable answer came back in time. */
  | "no-answer";

/** The provider's own reason, when a provider-error carried one
 *  (provider-reason.ts): the sentence then says what to do about THAT. */
export type ProviderErrorReason = "invalid_key" | "quota" | "model_unavailable" | "unreachable" | "unknown";

function providerErrorWords(reason: ProviderErrorReason | undefined): { hint: string; chip: string; retry: boolean } | null {
  switch (reason) {
    case "invalid_key":
      return { hint: "Matched by keywords: the AI's key is not valid. Replace it.", chip: "Matched by keywords: the AI's key is not valid.", retry: false };
    case "quota":
      return { hint: "Matched by keywords: the AI hit its usage limit. Retry later.", chip: "Matched by keywords: the AI's usage limit.", retry: true };
    case "model_unavailable":
      return { hint: "Matched by keywords: the AI's model is not available.", chip: "Matched by keywords: the AI's model is not available.", retry: false };
    case "unreachable":
      return { hint: "Matched by keywords: the AI could not be reached. Retry with AI.", chip: "Matched by keywords: the AI could not be reached.", retry: true };
    default:
      return null;
  }
}

/** The sentence the server writes into the routing note. One plain sentence
 *  a phone card can show whole (scan-copy.ts, CARD_SENTENCE_MAX); the
 *  remedy is the card's own button. */
export function fallbackHint(why: AiFallback, reason?: ProviderErrorReason): string {
  const own = why === "provider-error" ? providerErrorWords(reason) : null;
  if (own) return own.hint;
  switch (why) {
    case "no-provider":
      return "Connect an AI provider for a sharper name and filled-in fields.";
    case "background":
      return "Routed without your personal AI. Retry with AI to use it.";
    case "not-entitled":
      return "Matched by keywords: the AI allowance is used up for now.";
    case "provider-error":
      return "Matched by keywords: the AI errored. Retry with AI.";
    case "no-answer":
      return "Matched by keywords: the AI did not answer in time. Retry with AI.";
  }
}

/** Every sentence fallbackHint has ever written. A row keeps the prose it
 *  was written with, and the routing note's stripper must recognise all of
 *  them so a re-run cannot stack an old sentence under a new one
 *  (routing-note.ts). A wording change ADDS here and never removes. */
export const RETIRED_FALLBACK_HINTS: readonly string[] = [
  "The AI's key is not valid, so this was matched by keywords. Replace the key on its connection.",
  "The AI refused this for its usage limit, so this was matched by keywords. Retry with AI later.",
  "The AI does not serve the model its connection names, so this was matched by keywords. Pick another model on the connection.",
  "The AI could not be reached, so this was matched by keywords. Retry with AI.",
  "Routed without your personal AI (this step ran in the background). Retry with AI to use it.",
  "The AI allowance for this workspace is used up for now, so this was matched by keywords.",
  "The AI errored on this one, so it was matched by keywords. Retry with AI.",
  "The AI did not answer in time, so this was matched by keywords. Retry with AI.",
];

/** The card's one line beside the keyword match, and whether a retry helps. */
export function fallbackChip(why: AiFallback, reason?: ProviderErrorReason): { text: string; retry: boolean; connect: boolean } {
  const own = why === "provider-error" ? providerErrorWords(reason) : null;
  if (own) return { text: own.chip, retry: own.retry, connect: false };
  switch (why) {
    case "no-provider":
      return { text: "Matched by keywords: no AI provider is connected.", retry: false, connect: true };
    case "background":
      return { text: "Routed without your personal AI.", retry: true, connect: false };
    case "not-entitled":
      return { text: "Matched by keywords: the AI allowance is used up for now.", retry: false, connect: false };
    case "provider-error":
      return { text: "Matched by keywords: the AI errored.", retry: true, connect: false };
    case "no-answer":
      return { text: "Matched by keywords: the AI didn't answer.", retry: true, connect: false };
  }
}

// ── a photo the identify step could not name ────────────────────────────────
//
// The note under an unidentified photo listed every possible reason at once
// ("no vision provider configured, the model errored, or no single item was
// visible"), which told the person nothing they could act on: with a
// verified connection and seven photos identified around it, "no provider"
// was simply untrue (the 2026-09-13 review, #2916). The identify step now
// reports WHICH of those it was, as a code, and this is the sentence for
// each. Same vocabulary as the keyword floor above; a different outcome (no
// name at all, rather than a name from keywords), so different words.

export type IdentifyFailureCode =
  /** The router refused or the provider failed: `ai` says which. */
  | "ai_unavailable"
  /** The model answered, and the answer could not be read. */
  | "no_answer"
  /** The model looked and saw nothing it could name as one item. */
  | "no_item";

export interface IdentifyFailure {
  code: IdentifyFailureCode;
  ai?: AiFallback;
  ai_reason?: ProviderErrorReason;
  /** The raw reason, for the log; the sentence never shows it. */
  reason?: string;
}

/** The note the server writes under a photo it could not name, the why for
 *  its title, whether a retry would help, and whether connecting a provider
 *  is the remedy. The sentence is one line a phone card can show whole; the
 *  remedy rides in `detail`. */
export function identifyFailureWords(f: IdentifyFailure): { sentence: string; detail: string; retry: boolean; connect: boolean } {
  if (f.code === "no_item") {
    return { sentence: "The AI saw no single item to name in this photo.", detail: "Name it yourself, or read it as a receipt if that is what it is.", retry: false, connect: false };
  }
  if (f.code === "no_answer") {
    return { sentence: "Couldn't identify this photo: the AI's answer could not be read.", detail: "Identify it again.", retry: true, connect: false };
  }
  switch (f.ai) {
    case "no-provider":
      return { sentence: "Couldn't identify this photo: no AI provider is connected.", detail: "Connect one under Configuration, AI, or your own under Account, or name it yourself.", retry: false, connect: true };
    case "background":
      return { sentence: "Couldn't identify this photo: it ran without your personal AI.", detail: "Identify it again to use it.", retry: true, connect: false };
    case "not-entitled":
      return { sentence: "Couldn't identify this photo: the AI allowance is used up for now.", detail: "Identify it again later, or name it yourself.", retry: true, connect: false };
    case "provider-error":
      switch (f.ai_reason) {
        case "invalid_key":
          return { sentence: "Couldn't identify this photo: the AI's key is not valid.", detail: "Replace the key on its connection, then identify it again.", retry: false, connect: true };
        case "quota":
          return { sentence: "Couldn't identify this photo: the AI hit its usage limit.", detail: "Identify it again later.", retry: true, connect: false };
        case "model_unavailable":
          return { sentence: "Couldn't identify this photo: the AI's model is not available.", detail: "Pick another model on the connection, then identify it again.", retry: false, connect: true };
        case "unreachable":
          return { sentence: "Couldn't identify this photo: the AI could not be reached.", detail: "Identify it again.", retry: true, connect: false };
        default:
          return { sentence: "Couldn't identify this photo: the AI errored.", detail: "Identify it again.", retry: true, connect: false };
      }
    case "no-answer":
      return { sentence: "Couldn't identify this photo: the AI did not answer in time.", detail: "Identify it again.", retry: true, connect: false };
    default:
      return { sentence: "Couldn't identify this photo.", detail: "Identify it again, or name it yourself.", retry: true, connect: false };
  }
}
