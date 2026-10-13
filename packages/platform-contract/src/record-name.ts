// A record's name is built from real values: never a field's label, never a
// placeholder the code wrote for a value nobody has (#6283, #6303).
//
// The Cataloging Bench committed a tool as "14mm 4-Flute Ball End Mill Carbide
// Tool 90mm Length 40mm Flute Length 30g Weight SKU: None Brand: Unbranded
// Category: power tool Entity Type: part Series: None Creator: None Barcode:
// None Serial Numbe": an identify answer that wrote the record's metadata
// into its name, labels and empty values and all, cut off mid-word at the
// column's length. It was the record's heading, its card, its photo's alt
// text. Every door that turns an answer into a name (identify, create-item,
// the scan's AI name) reads this one rule, so no door can do it again.

/** The labels of a record's own facts. Where one appears in a name, the name
 *  ended and its metadata began: everything from it on is not the name. Only
 *  these words count as a label, so a title with a colon of its own ("Dune:
 *  Messiah", "Star Wars: A New Hope") keeps it. */
export const METADATA_LABELS = [
  "sku",
  "brand",
  "category",
  "entity type",
  "series",
  "creator",
  "barcode",
  "serial number",
  "serial no",
  "model number",
  "model no",
  "manufacturer",
  "upc",
  "ean",
  "gtin",
  "mpn",
  "part number",
  "item number",
  "asin",
] as const;

/** What the code writes for a value nobody has, as the whole of a name:
 *  JavaScript's own stringified null and undefined (a template over a field
 *  that was never set). Only the whole name, in exactly that spelling. A
 *  word inside a name is never matched: "None of the Above", "Null Island"
 *  and "Undefined Behavior" are titles a person or a catalog gave, and a
 *  rule that matched the word cut the title's first word off (#6303). The
 *  placeholders that sit inside a name arrive behind a label ("SKU: None"),
 *  and the label's cut takes them. */
const STRINGIFIED_MISSING = /^(null|undefined)$/;

const LABEL_AT = new RegExp(`(^|[\\s,;|(])(${METADATA_LABELS.map((l) => l.replace(/ /g, "\\s+")).join("|")})\\s*:`, "i");

/** Where the metadata begins in `s`: the first label that has a name before
 *  it. A label first in the name is the name ("Series: A Study in Order"),
 *  not metadata after one. -1 when there is none. */
function metadataAt(s: string, labelAt: RegExp): number {
  const m = labelAt.exec(s);
  if (!m) return -1;
  const at = m.index + m[1]!.length;
  return s.slice(0, at).replace(/[\s,;:|/(-]+$/, "").trim() ? at : -1;
}

/** The name `raw` says, built from its real values: cut where a metadata
 *  label begins behind a name, the empty value after it going with it, its
 *  spaces and trailing commas tidied. "" when nothing real is left (nothing
 *  said, or only the stringified null or undefined). Words are never
 *  matched. `extraLabels` adds a kind's own field labels ("Flute count") to
 *  the ones above. */
export function recordName(raw: string | null | undefined, extraLabels: readonly string[] = []): string {
  let s = String(raw ?? "");
  if (STRINGIFIED_MISSING.test(s.trim())) return "";
  const at = metadataAt(s, LABEL_AT);
  if (at >= 0) s = s.slice(0, at);
  for (const label of extraLabels) {
    const t = label.trim();
    if (!t) continue;
    const own = new RegExp(`(^|[\\s,;|(])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\s*:`, "i");
    const cut = metadataAt(s, own);
    if (cut >= 0) s = s.slice(0, cut);
  }
  return s.replace(/\s+/g, " ").replace(/[\s,;:|/(-]+$/, "").replace(/^[\s,;:|/)-]+/, "").trim();
}

/** Does this name still hold metadata behind it (a label after a name)? For
 *  a test, and for a heal to find the names to rebuild. */
export function nameHoldsMetadata(name: string | null | undefined): boolean {
  return metadataAt(String(name ?? ""), LABEL_AT) >= 0;
}
