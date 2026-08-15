/** Cleaning a catalog record before anything downstream believes it.
 *
 *  A barcode hit reaches the row through five different provider tiers (the
 *  box-level resolver, BIdb, go-upc, upcitemdb, the Open*Facts trio), and its
 *  brand alone reaches `suggested_manufacturer` from seven different write
 *  sites. Normalising inside an adapter therefore fixes one tier and leaves the
 *  rest, which is exactly the state this replaced: `tryOpenFacts` split the
 *  brand list, and the resolver tier twenty lines below it passed the same
 *  field through untouched.
 *
 *  So this runs ONCE, on the way out of `lookupBarcode`, where every tier's
 *  answer converges. A new provider inherits it by existing. */

/** Accented Latin, or any non-Latin script. */
export function looksNonEnglish(s: string | null | undefined): boolean {
  if (!s) return false;
  // Accented Latin letters, skipping × (×) and ÷ (÷).
  if (/[À-ÖØ-öø-ſ]/.test(s)) return true;
  // Any non-Latin script (Greek, Cyrillic, CJK, Arabic, Hebrew, …).
  if (/[Ͱ-῿Ⰰ-퟿豈-﷿ﹰ-﻿＀-￯]/.test(s)) return true;
  return false;
}

/** The one brand to show, from a field that may carry several.
 *
 *  Open Food Facts `brands` is a comma-separated SYNONYM LIST, not a single
 *  value: a Lidl baking powder carries "Belbake, Dolciando, Elbake, Lidl", and
 *  a tea carries "Celestial Seasonings, Celestial Seasonings  Inc.". Prefixed
 *  to a title whole, that reads as the brand repeating itself in the item's own
 *  name (reported 2026-08-14). The first entry is the canonical one in OFF's
 *  own convention, and it is the shortest useful thing to show. */
export function primaryBrand(brand: string | null | undefined): string | null {
  if (!brand) return null;
  const first = brand.split(",")[0]?.trim().replace(/\s+/g, " ") ?? "";
  return first || null;
}

/** The Open*Facts name to use, given that record's alternatives.
 *
 *  Verified against the live records that prompted this (2026-08-14):
 *
 *    20446079       product_name "Kreuzkümmel gemahlen"  _en "cumin"     -> "cumin"
 *    4056489309697  product_name "corn Starch"           _en absent      -> "corn Starch"
 *    4056489546849  product_name "Backpulver"            _en "Backpulver" -> "Backpulver"
 *
 *  The last one is the honest limit of this, and it is worth stating rather
 *  than papering over: OFF's English field there contains the GERMAN word, so
 *  no choice among the record's own fields yields "baking powder". Translating
 *  it is a different job than picking a field, and it is not done here.
 *
 *  `lang`/`lc` are deliberately NOT consulted. They are wrong often enough to
 *  mislead: that same Backpulver record is tagged `es`, and the already-English
 *  "corn Starch" is tagged `de`. A script test on the value in hand beats a
 *  metadata field about it. */
export function preferredFactsName(p: {
  product_name?: unknown;
  product_name_en?: unknown;
  generic_name?: unknown;
  generic_name_en?: unknown;
}): string {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const base = str(p.product_name);
  const baseEn = str(p.product_name_en);
  const generic = str(p.generic_name);
  const genericEn = str(p.generic_name_en);

  // An English alternative only wins when the primary actually reads foreign;
  // otherwise the primary is the record's own best name and the _en field is
  // usually just a copy of it.
  if (base && looksNonEnglish(base) && baseEn && !looksNonEnglish(baseEn)) return baseEn;
  if (base) return base;
  if (baseEn) return baseEn;
  if (generic && looksNonEnglish(generic) && genericEn && !looksNonEnglish(genericEn)) return genericEn;
  return generic || genericEn || "";
}
