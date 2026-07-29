// Shared prompt for the `rank-images` capability: shown N candidate photos of
// ONE item, pick the single best CATALOG image. Both provider adapters (OpenAI,
// Anthropic) inject it so the output shape is identical regardless of the model
// a workspace configures — the same discipline identify-prompt.ts follows.
//
// This is the ONLY capability that sends more than one image in a call. The
// heuristic ranker (core-scan's catalogScore) is the instant, free floor; this
// is the "uses more tokens" upgrade that actually LOOKS at the pixels, so it can
// enforce the two things a title never reveals: no person in frame, and the
// real colour of the thing.
//
// Priorities, in order (the author, 2026-07-29): (1) the product ALONE — no people, no
// tag/packaging-only shots; (2) correct COLOUR, the top visual match; (3) a
// clean studio/catalog look.
//
// The base priorities are universal, then ONE category-derived line sharpens or
// OVERRIDES them (see categoryGuidance) — the same additive-context pattern
// identify-prompt.ts uses (measurementContext). This is not just decluttering:
// the "reject the packaging" rule INVERTS by category (for a food item the front
// of the box IS the correct catalog shot), so category-awareness is a
// correctness fix, not a preference.

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A short, category-derived line appended to the base prompt. Keeps the base
 *  lean AND fixes the packaging rule, which inverts by category: for a garment
 *  or a tool a photo of just the packaging/tag is not the product, but for a
 *  packaged good (food, cosmetics, a boxed toy) the FRONT of the retail package
 *  IS the catalog shot. Derived from the identify's coarse category — matched
 *  on WHOLE tokens, never substrings: the first cut used `includes()` and
 *  "pantry" matched "pant" (apparel!), "socket" matched "sock", "dresser"
 *  matched "dress" — each steering the model to the WRONG kind of photo.
 *  Returns "" when the base priorities already cover it (tools, electronics,
 *  parts, general goods). */
const APPAREL_TOKENS = new Set([
  "clothing", "clothes", "apparel", "garment", "garments", "shirt", "shirts",
  "tee", "tees", "shoe", "shoes", "footwear", "sneaker", "sneakers", "boot",
  "boots", "hat", "hats", "sock", "socks", "jacket", "jackets", "hoodie",
  "hoodies", "dress", "dresses", "pants", "trousers", "jeans", "shorts",
  "textile", "textiles", "activewear", "outerwear", "sportswear", "underwear",
]);
const PACKAGED_TOKENS = new Set([
  "food", "foods", "grocery", "groceries", "snack", "snacks", "drink",
  "drinks", "beverage", "beverages", "pantry", "consumable", "consumables",
  "spice", "spices", "condiment", "condiments", "supplement", "supplements",
  "cosmetic", "cosmetics", "beauty", "cleaning", "detergent", "toiletry",
  "toiletries", "sauce", "cereal",
]);
const MEDIA_TOKENS = new Set([
  "book", "books", "novel", "media", "dvd", "cd", "vinyl", "album", "albums",
  "movie", "movies", "film", "films", "magazine", "magazines", "comic",
  "comics", "game", "games",
]);

export function categoryGuidance(input: Record<string, unknown>): string {
  const tokens = str(input.category).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const anyIn = (set: Set<string>): boolean => tokens.some((t) => set.has(t));

  if (anyIn(APPAREL_TOKENS)) {
    return "Category note: this is apparel. Pick the garment on its own (flat, or on a plain background), " +
      "never worn by a person or shown on a mannequin, and never a photo of the tag. Getting the colour right matters most here.";
  }
  if (anyIn(PACKAGED_TOKENS)) {
    return "Category note (overrides the packaging rule above): this is a packaged good. The FRONT of the retail " +
      "package, bottle, or box IS the correct catalog image — prefer it, do not treat the packaging as clutter. " +
      "Match the exact product, flavour, and variant.";
  }
  if (anyIn(MEDIA_TOKENS)) {
    return "Category note (overrides the packaging rule above): this is a titled work. Pick the cover art (usually " +
      "portrait); people printed ON the cover are fine, but reject a photo of a person holding it. Match the exact edition.";
  }
  return "";
}

/** One candidate image the adapter will push as a content block. */
export interface RankImage {
  b64: string;
  mediaType: string;
}

/** Normalise `input.images` (the ordered list the caller sent) into the shape
 *  both adapters push. Each entry is `{ image_b64, image_media_type? }`; a
 *  missing media type defaults to JPEG. Shared so OpenAI and Anthropic can
 *  never disagree about which/how many images the prompt's indices refer to. */
export function rankImageInputs(input: Record<string, unknown>): RankImage[] {
  const raw = Array.isArray(input.images) ? input.images : [];
  const out: RankImage[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    const b64 = typeof rec.image_b64 === "string" ? rec.image_b64 : "";
    if (!b64) continue;
    out.push({ b64, mediaType: typeof rec.image_media_type === "string" ? rec.image_media_type : "image/jpeg" });
  }
  return out;
}

/**
 * The prompt a `rank-images` call ACTUALLY sends. Derived from the text context
 * the caller passes (item name/brand/colour and whether image 0 is a reference
 * photo of the real item) — never from the image bytes, which are already in
 * the cache key. EVERY consumer routes through here: the adapters that send it
 * AND the fingerprint that keys the cache on it, so the two can never drift.
 */
export function rankImagesPromptFor(input: Record<string, unknown>): string {
  const name = str(input.item_name);
  const brand = str(input.brand);
  const color = str(input.known_color);
  const hasRef = input.has_reference === true;
  // Count what the adapters will actually PUSH (the normalised list), not the
  // raw array — an entry without bytes is skipped by rankImageInputs, and a
  // count mismatch would shift every index the model is told about.
  const n = rankImageInputs(input).length;
  const firstCandidate = hasRef ? 1 : 0;
  const lastCandidate = Math.max(firstCandidate, n - 1);

  const what = [name, brand ? `by ${brand}` : ""].filter(Boolean).join(" ") || "an item";

  const lines: string[] = [];
  lines.push(
    `You are choosing the single best CATALOG photo for ${what}. ` +
      `You are shown ${n} image${n === 1 ? "" : "s"}, numbered 0 to ${n - 1} in the order given.`,
  );
  if (hasRef) {
    lines.push(
      `Image 0 is a REFERENCE photo of the ACTUAL item the user owns. It may be ` +
        `dark, blurry, or cluttered — use it ONLY to judge the item's true COLOUR ` +
        `and identity. NEVER choose image 0.`,
    );
  }
  lines.push(
    `Choose the ONE best candidate from images ${firstCandidate} to ${lastCandidate}, ` +
      `by these priorities in order:`,
  );
  lines.push(
    `1. It shows ONLY the product itself. Reject any image with a person, a hand, ` +
      `a face, or a mannequin in it; reject a photo of just a tag, label, receipt, ` +
      `or the packaging/box. Prefer a plain, uncluttered background (ideally white).`,
  );
  lines.push(
    `2. Correct COLOUR is the most important visual match. ` +
      (color ? `The item's colour is "${color}". ` : "") +
      (hasRef ? `Match the colour you see in the reference image 0. ` : "") +
      `An image showing the wrong colour is the wrong variant — do not pick it.`,
  );
  lines.push(`3. Prefer a clean studio / catalog look over a lifestyle or in-use shot.`);
  const guidance = categoryGuidance(input);
  if (guidance) lines.push(guidance);
  lines.push(
    `Reply with ONLY a JSON object: ` +
      `{"chosen_index": <integer from ${firstCandidate} to ${lastCandidate}>, ` +
      `"reason": "<one short sentence on why>", ` +
      `"color_seen": "<the colour of the item in the image you chose>"}. ` +
      `If none are good, pick the least-bad candidate and say so in "reason".`,
  );
  return lines.join("\n\n");
}
