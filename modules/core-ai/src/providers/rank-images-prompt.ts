// Shared prompt for the `rank-images` capability: shown ONE image — a numbered
// contact sheet of candidate photos for a single item — pick the best tile. Every
// provider adapter injects it through this one resolver, so the output shape is
// identical regardless of the model a workspace configures (the same discipline
// identify-prompt.ts follows).
//
// It used to send the candidates as N SEPARATE attachments. One composed sheet is
// better on every axis: a fraction of the image tokens, and it needs only the
// single-image path every adapter already has for identify-image. The
// multi-attachment version silently worked on two adapters (OpenAI, Anthropic)
// and failed on the three a real workspace was actually using — the button
// returned "no provider configured for capability rank-images" on the edge
// bridge. It also puts the user's own photo in the SAME frame for colour
// comparison, and a tile is a position in one picture, so there is no
// attachment-offset to get wrong. Composed in core-scan's contact-sheet.ts.
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
const num = (v: unknown, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : dflt;

/** A short, category-derived line appended to the base prompt. Keeps the base
 *  lean AND fixes the packaging rule, which inverts by category: for a garment
 *  or a tool a photo of just the packaging/tag is not the product, but for a
 *  packaged good (food, cosmetics, a boxed toy) the FRONT of the retail package
 *  IS the catalog shot. Matched on WHOLE tokens, never substrings: the first cut
 *  used `includes()` and "pantry" matched "pant" (apparel!), "socket" matched
 *  "sock", "dresser" matched "dress" — each steering the model to the WRONG kind
 *  of photo. Returns "" when the base priorities already cover it (tools,
 *  electronics, parts, general goods). */
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

/**
 * The prompt a `rank-images` call ACTUALLY sends. Derived from the text context
 * the caller passes (the item's name/brand/colour/category and the sheet's
 * shape) — never from the image bytes, which are already in the cache key. EVERY
 * consumer routes through here: the adapters that send it AND the fingerprint
 * that keys the cache on it, so the two can never drift.
 *
 * The sheet's geometry is described EXACTLY as contact-sheet.ts composes it
 * (numbers printed per tile, `cols` across, reading left-to-right then
 * top-to-bottom, the user's photo as an unnumbered strip on top). Those two
 * files are one contract; the composer's test pins the layout.
 */
export function rankImagesPromptFor(input: Record<string, unknown>): string {
  const name = str(input.item_name);
  const brand = str(input.brand);
  const color = str(input.known_color);
  const hasRef = input.has_reference === true;
  const tiles = Math.max(1, num(input.tiles, 1));
  const cols = Math.max(1, num(input.cols, 3));

  const what = [name, brand ? `by ${brand}` : ""].filter(Boolean).join(" ") || "an item";

  const lines: string[] = [];
  lines.push(
    `You are choosing the single best CATALOG photo for ${what}. ` +
      `The image you have been given is a CONTACT SHEET: ${tiles} candidate ` +
      `photo${tiles === 1 ? "" : "s"}, laid out ${cols} across, each in its own ` +
      `tile with its number printed in the tile's top-left corner. The tiles are ` +
      `numbered 1 to ${tiles}, left to right, then top to bottom.`,
  );
  if (hasRef) {
    lines.push(
      `The full-width strip ACROSS THE TOP, above the numbered tiles, is the ` +
        `user's own photo of the ACTUAL item they own. It may be dark, blurry or ` +
        `cluttered. Use it ONLY to judge the item's true COLOUR and identity: it ` +
        `is not a candidate, it has no number, and you must never choose it.`,
    );
  }
  lines.push(`Choose the ONE best numbered tile, by these priorities in order:`);
  lines.push(
    `1. It shows ONLY the product itself. Reject any tile with a person, a hand, ` +
      `a face, or a mannequin in it; reject a photo of just a tag, label, receipt, ` +
      `or the packaging/box. Prefer a plain, uncluttered background (ideally white).`,
  );
  lines.push(
    `2. Correct COLOUR is the most important visual match. ` +
      (color ? `The item's colour is "${color}". ` : "") +
      (hasRef ? `Match the colour you see in the strip at the top. ` : "") +
      `A tile showing the wrong colour is the wrong variant — do not pick it.`,
  );
  lines.push(`3. Prefer a clean studio / catalog look over a lifestyle or in-use shot.`);
  const guidance = categoryGuidance(input);
  if (guidance) lines.push(guidance);
  lines.push(
    `Reply with ONLY a JSON object: ` +
      `{"chosen_tile": <the tile's printed number, an integer from 1 to ${tiles}>, ` +
      `"reason": "<one short sentence on why>", ` +
      `"color_seen": "<the colour of the item in the tile you chose>"}. ` +
      `If none are good, pick the least-bad tile and say so in "reason".`,
  );
  return lines.join("\n\n");
}
