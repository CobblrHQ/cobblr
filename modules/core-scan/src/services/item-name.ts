// The item's NAME, with the colour in it.
//
// A colour reached the photo search and the ranking, but not the title, so a
// corrected item still READ as colourless: "Under Armour Icon Charged Cotton SS
// T-Shirt" with no hint that it is the black one (the author, 2026-07-30 - he expected
// the hint to "add to the title and or image search term"). For a garment or a
// tool the colour is part of which one it IS, so it belongs in the name.
//
// Deterministic, not asked of a model: the colour is already resolved, and code
// that appends a known word is free, instant and testable (heuristic-first).

import { colorFromText } from "./ddg-images.js";

const title = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * `name` with `color` reflected in it.
 *
 *   "UA Icon T-Shirt"          + black  ->  "UA Icon T-Shirt, Black"
 *   "UA Icon T-Shirt, Black"   + black  ->  unchanged (already right)
 *   "UA Blue Icon T-Shirt"     + black  ->  "UA Black Icon T-Shirt"  (corrected)
 *
 * The replacement is the point: after correcting the colour, a title still
 * carrying the OLD one is worse than no colour at all, because it now
 * confidently contradicts the photo it sits next to.
 *
 * `brand` is the guard against mangling a name whose colour word is part of the
 * BRAND. "Red Heart Super Saver Yarn" in blue must not become "Blue Heart Super
 * Saver Yarn" - the brand's "Red" is its name, not a description. In that case
 * the colour is appended instead of substituted.
 */
export function nameWithColor(
  name: string | null | undefined,
  color: string | null | undefined,
  brand?: string | null,
): string {
  const n = (name ?? "").trim();
  const c = (color ?? "").trim();
  if (!n || !c) return n;

  const inName = colorFromText(n);
  // Already says the right colour.
  if (inName && inName.toLowerCase() === c.toLowerCase()) return n;

  if (inName) {
    const brandHasIt = colorFromText(brand ?? "")?.toLowerCase() === inName.toLowerCase();
    // The colour word belongs to the brand - leave it alone and add ours.
    if (brandHasIt) return `${n}, ${title(c)}`;
    return n.replace(new RegExp(`\\b${inName}\\b`, "i"), title(c));
  }
  return `${n}, ${title(c)}`;
}

/**
 * A name recovered from a TRUNCATED model reply, trimmed back to its last
 * complete part.
 *
 * The reply parsers deliberately rescue a cut-off JSON body - a reply that hit
 * the token limit still carries a usable answer, and losing it entirely is
 * worse. But the rescued string can END MID-THOUGHT, and that lands in the row
 * as the item's name: "Under Armour Icon Charged Cotton SS T-Shirt (Men's" -
 * an unclosed bracket, visible on the card (the author, 2026-07-30: "in fact mangled
 * the first one"). Composing a colour onto it only compounds it (", Black"
 * after a dangling paren).
 *
 * So a name with an unbalanced opener is cut at that opener: the shorter name is
 * CORRECT, where the longer one is visibly broken. A balanced name is untouched,
 * because most names are fine and this must not rewrite them.
 */
export function tidyTruncatedName(name: string | null | undefined): string {
  let n = (name ?? "").trim();
  if (!n) return "";
  const PAIRS: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  for (const [open, close] of PAIRS) {
    const opens = n.split(open).length - 1;
    const closes = n.split(close).length - 1;
    if (opens > closes) n = n.slice(0, n.lastIndexOf(open));
  }
  // A cut can also leave a dangling separator ("… T-Shirt," / "… T-Shirt -").
  return n.replace(/[\s,;:\-–—/&+]+$/u, "").trim();
}
