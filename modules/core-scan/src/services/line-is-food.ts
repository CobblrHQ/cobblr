// What a receipt says about a line before anyone knows what the line is (#9270).
// "Assorted Thin" at 2.62 lb, from a grocer's till, went to Inventory with a photo
// of sewing needles: the name says nothing, and the shape of the line says food.
// Evidence, not an answer: it only steers a route that nothing else could settle,
// and the row is still asked about. Pure.

/** Names a shop is known by when what it sells is mostly food. A short list on
 *  purpose: a shop not on it just gets no help, and a wrong one misroutes. */
const GROCERS = /\b(lidl|aldi|kroger|safeway|publix|wegmans|trader joe'?s|whole foods|shoprite|stop & shop|food lion|albertsons|h-?e-?b|sprouts|tesco|sainsbury'?s|asda|morrisons|waitrose|grocer(?:y|ies)?|supermarket|food ?(?:mart|market|hall))\b/i;

const SHOPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\blidl\b/i, "Lidl"], [/\baldi\b/i, "Aldi"], [/\bkroger\b/i, "Kroger"], [/\bsafeway\b/i, "Safeway"], [/\bpublix\b/i, "Publix"],
  [/\bwegmans\b/i, "Wegmans"], [/\btrader joe'?s\b/i, "Trader Joe's"], [/\bwhole foods\b/i, "Whole Foods"], [/\bshoprite\b/i, "ShopRite"],
  [/\bstop & shop\b/i, "Stop & Shop"], [/\bfood lion\b/i, "Food Lion"], [/\balbertsons\b/i, "Albertsons"], [/\bsprouts\b/i, "Sprouts"],
  [/\btesco\b/i, "Tesco"], [/\bsainsbury'?s\b/i, "Sainsbury's"], [/\basda\b/i, "Asda"], [/\bmorrisons\b/i, "Morrisons"], [/\bwaitrose\b/i, "Waitrose"],
];
/** A till's own line about itself: its loyalty scheme or a saving, or its address on the web. */
const SHOP_SPEAKING = /\b(plus|discount|coupon|savings?|rewards?|thank|welcome|store)\b|\.(?:com|co\.uk)\b/i;

/** A known shop that speaks for itself further down a receipt whose top says
 *  nothing, as a screenshot's does: "Lidl Plus Discount", "lidl.com" (#9270). Only
 *  a line that is the shop talking: "Trader Joe's Cookies 3.99" at another shop is
 *  an item, and "Grocery" is a department. Pure. */
export function grocerNamedOn(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!SHOP_SPEAKING.test(line)) continue;
    for (const [re, name] of SHOPS) if (re.test(line)) return name;
  }
  return null;
}

export function looksLikeAGrocer(vendor: unknown): boolean {
  return typeof vendor === "string" && GROCERS.test(vendor);
}

/** Whether the match may go looking for a picture. Below the floor the name is a
 *  guess, and a picture found for a guess is worse than none: "Assorted Thin" came
 *  home with sewing needles. */
export function pictureAfterMatchAllowed(topConfidence: unknown, floor: number): boolean {
  const n = Number(topConfidence);
  return Number.isFinite(n) && n >= floor;
}

/** A till's line sold by weight, or any line from a grocer. An order page or an
 *  email is a shop that posts things, and pounds of nails can come that way. */
export function receiptLineReadsAsFood(meta: Record<string, unknown> | null | undefined): boolean {
  const m = meta ?? {};
  if (typeof m.receipt_group_id !== "string") return false;
  if (looksLikeAGrocer(m.receipt_vendor)) return true;
  const posted = m.receipt_origin === "email" || !!m.store_host || (typeof m.parse_method === "string" && m.parse_method.startsWith("order"));
  return !posted && typeof m.weight === "number" && m.weight > 0;
}
