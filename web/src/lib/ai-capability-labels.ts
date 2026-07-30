// What each AI job is CALLED on the AI settings page.
//
// A capability with no entry here falls through to its prettified id, so the
// page shows raw jargon: `rank-images` rendered as "Rank images", which nobody
// could tell apart from the "pick photos automatically" setting sitting above it
// ("Rank images is already on the AI page, is this not the same thing?" - the author,
// 2026-07-30). The ids are internal; the page is for a person deciding which AI
// to spend money on, so every capability gets a plain-English name.
//
// ai-capability-labels.test.ts asserts EVERY capability in the contract has one,
// so the next capability someone adds cannot ship unlabelled.

import type { AiCapability } from "@cobblr/platform-contract";

export const CAPABILITY_LABELS: Record<AiCapability, string> = {
  // The scan's "what is this?" read of a photo. Deliberately distinct from
  // classify-image below: both look at a picture, and calling them both
  // "Identify a photo" made the two rows indistinguishable.
  "identify-image": "Identify a scanned item",
  "classify-image": "Sort a photo into categories",
  "rank-images": "Pick the best product photo",
  "extract-text": "Read text in an image",
  "match-to-catalog": "Match to a catalog",
  "embed-text": "Build search embeddings",
  summarise: "Summarise text",
  chat: "Ask Cobb",
};

/** Older/aliased ids that still appear in stored config rows. Not capabilities
 *  in the contract, so they are kept apart from the exhaustive map above. */
const LEGACY_LABELS: Record<string, string> = {
  summarize: "Summarise text",
  embed: "Build search embeddings",
  extract: "Pull fields out of text",
  ocr: "Read text in an image",
  rank: "Rank options",
  transcribe: "Transcribe audio",
};

export function capabilityLabel(cap: string): string {
  const known = (CAPABILITY_LABELS as Record<string, string>)[cap] ?? LEGACY_LABELS[cap];
  if (known) return known;
  // An unknown id (a provider's own extension) still reads better prettified
  // than raw, but a CONTRACT capability reaching here is a bug the test catches.
  const words = cap.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
