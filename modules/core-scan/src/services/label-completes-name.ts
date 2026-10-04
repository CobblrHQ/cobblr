// A barcode that resolved only to the BRAND does not beat the label (#4583).
//
// A catalog answer of "Zero Carbon Tea" for a canister whose front says
// "PUMPKIN SPICED CHAI" names the maker and a generic noun, no variant, flavour,
// size or model. The photo's printed title is the better evidence for the
// variant, so the name is completed from it: brand + variant. The barcode stays
// the identity; the label supplies what the catalog did not know. Pure.

const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);

/** Words that join a maker's name to nothing: dropped before counting what a
 *  name says beyond its brand. */
const FILLER = new Set(["the", "and", "of", "co", "company", "inc", "llc", "ltd", "corp"]);

/** The name says no more than the brand and (at most) one generic noun. A digit
 *  (a size, a model number) or a second leftover word is a variant: not
 *  brand-level. */
export function isBrandLevelName(name: string | null | undefined, brand: string | null | undefined): boolean {
  const n = words(name ?? "");
  if (n.length === 0) return false;
  const b = new Set(words(brand ?? "").filter((w) => !FILLER.has(w)));
  const rest = n.filter((w) => !FILLER.has(w) && !b.has(w));
  if (rest.some((w) => /\d/.test(w))) return false;
  // With no brand known, a single word is the whole name: no variant either.
  return rest.length <= 1 && (b.size > 0 ? n.some((w) => b.has(w)) || rest.length === 0 : n.length <= 2);
}

/** The name the label supports, or null when the label adds nothing or the
 *  name is not brand-level. `printedTitle` is the title as printed on the
 *  front, `printedBrand` the brand as printed. */
export function nameCompletedFromLabel(input: {
  name: string;
  brand: string | null;
  printedTitle: string | null | undefined;
  printedBrand?: string | null | undefined;
}): string | null {
  const title = (input.printedTitle ?? "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  if (!isBrandLevelName(input.name, input.brand)) return null;
  const nameWords = new Set(words(input.name));
  const titleWords = words(title);
  // Nothing new on the label: leave the name alone.
  if (titleWords.every((w) => nameWords.has(w))) return null;
  // A label that names a DIFFERENT maker is a mismatch, which is the
  // cross-check's job, not a completion. A label that names none (a flavour
  // alone, the usual front) is this item's: the barcode already said whose.
  const brandWords = words(input.brand ?? input.name).filter((w) => !FILLER.has(w));
  const printed = words(input.printedBrand ?? "").filter((w) => !FILLER.has(w));
  if (printed.length > 0 && brandWords.length > 0 && !printed.some((w) => brandWords.includes(w))) return null;
  const titleCased = title === title.toUpperCase() ? title.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : title;
  // The title already leads with the maker: it is the whole name.
  if (brandWords.length > 0 && brandWords.every((w) => titleWords.includes(w))) return titleCased;
  return `${input.name.trim()} ${titleCased}`.replace(/\s+/g, " ").trim();
}
