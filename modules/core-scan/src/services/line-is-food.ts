// What a receipt says about a line before anyone knows what the line is (#9270).
// "Assorted Thin" at 2.62 lb, from a grocer's till, went to Inventory with a photo
// of sewing needles: the name says nothing, and the shape of the line says food.
// Evidence, not an answer: it only steers a route that nothing else could settle,
// and the row is still asked about. Pure.

/** Names a shop is known by when what it sells is mostly food. A short list on
 *  purpose: a shop not on it just gets no help, and a wrong one misroutes. */
const GROCERS = /\b(lidl|aldi|kroger|safeway|publix|wegmans|trader joe'?s|whole foods|shoprite|stop & shop|food lion|albertsons|h-?e-?b|sprouts|tesco|sainsbury'?s|asda|morrisons|waitrose|grocer(?:y|ies)?|supermarket|food ?(?:mart|market|hall))\b/i;

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
