// "The same product": the one rule behind every place the platform decides
// that two things are one thing.
//
// Three surfaces make that call: the inbox's Combine offer ("2 items look
// like the same product"), the scan's "you already have this" match against
// the workspace's records, and the filing-time duplicate check. They read
// different rows, but the question is one question, and the identity a
// record already carries outranks any word overlap in its name.
//
// Two LEGO sets, 40702 and 75684, were offered as one product (#2977): the
// name rule dropped every pure-digit word before comparing, the model-number
// veto knew only letter-and-digit shapes, and nobody read the candidates'
// `set_number`, which said plainly they differ. The character-jug fix before
// it was the instance; this is the class:
//
//   1. Identifier fields are decisive. A field that names WHICH one (a set
//      number, a model, a part number, a SKU, an ISBN, a serial, or any field
//      the kind flags `identifier`) with different values on the two sides
//      means two products, before any name rule; equal values mean one; a
//      value on one side only says nothing.
//   2. A model number in a name is decisive too, and a run of four or more
//      digits that is not a unit or a year is one (40702 is a set number;
//      "10pk" and "2026" are not). Two names whose model numbers disagree are
//      two products; a shared one is one.
//
// One implementation, imported by all three surfaces; a test holds them to it.

/** Field names that hold a product's identity, across the words people use.
 *  Any field flagged `field_role: identifier` counts too, whatever its name. */
export const IDENTIFIER_FIELD_NAMES =
  /^(set_number|set_no|set|model|model_number|model_no|part_number|part_no|part|sku|mpn|serial|serial_number|serial_no|isbn|isbn10|isbn13|upc|ean|gtin|asin|catalog_number|catalogue_number|item_number|vin|reg(?:istration)?(?:_number)?|licence_plate|license_plate)$/i;

export function isIdentifierField(name: string, role?: string | null): boolean {
  if (role === "identifier") return true;
  return IDENTIFIER_FIELD_NAMES.test(name.trim());
}

/** An identifier as it compares: case, spaces, dashes and dots do not make
 *  two of "WYS-1234", "wys 1234" and "WYS.1234". */
export function identifierKey(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase().replace(/[\s.\-_/]+/g, "");
  return s || null;
}

/** A `model` field holds a name as often as a number ("Civic", "Prusa MK4"):
 *  it identifies only when it carries a digit. Every other identifier field
 *  is a code by nature. */
function identifies(name: string, key: string): boolean {
  return /^model$/i.test(name.trim()) ? /\d/.test(key) : true;
}

export type IdentifierVerdict = "same" | "different" | "unknown";

/**
 * What the identifier fields say about two field bags: `different` when any
 * identifier both carry disagrees, `same` when at least one agrees and none
 * disagrees, `unknown` when they share no filled identifier. Field roles are
 * consulted when given (a workspace's own "catalogue no." flagged as an
 * identifier), names otherwise.
 */
export function compareIdentifiers(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
  roles?: Record<string, string | null | undefined> | null,
): IdentifierVerdict {
  if (!a || !b) return "unknown";
  let agreed = 0;
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    if (!isIdentifierField(k, roles?.[k] ?? null)) continue;
    const x = identifierKey(a[k]);
    const y = identifierKey(b[k]);
    if (!x || !y || !identifies(k, x) || !identifies(k, y)) continue;
    if (x !== y) return "different";
    agreed++;
  }
  return agreed ? "same" : "unknown";
}

/** Unit-ish tokens ("75mm", "10pk", "120v") are measurements, not identity —
 *  they must neither count as model numbers nor veto anything. */
export const UNIT_TOKEN = /^\d+(pk|ct|pcs?|oz|ml|lb|kg|mm|cm|in|ft|gal|qt|ah|mah|[wvagl])$/;

/** A run of digits that is a year, not a number the maker gave the thing. */
const YEAR_TOKEN = /^(19|20)\d{2}$/;

/** Tokens that read as MODEL NUMBERS: letters+digits interleaved
 *  ("F27T350FHN", "S23A300B", "MSB1G"), a single-letter prefix on a run of
 *  digits ("D6733", "A1234"), or a bare run of four or more digits that is
 *  not a unit or a year ("40702", "75684": the catalogue-code shape LEGO and
 *  most set and part numbering use). A model number IS the product's
 *  identity: two names whose model numbers disagree are different products
 *  no matter how many generic words ("inch", "monitor", "building set") they
 *  share.
 *
 *  Requiring TWO letters once made a single-letter code invisible, so nine
 *  different character jugs (D6733, D6527, D6691…) sailed past the veto
 *  written for exactly this; dropping every pure-digit word did the same to
 *  two LEGO sets. The digit floor is what keeps the looser shapes honest:
 *  "3d", "x10", "a4", "3 piece" and "2026" stay words, not identities. */
export function modelNumberTokens(s: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length < 4 || UNIT_TOKEN.test(w)) continue;
    const letters = (w.match(/[a-z]/g) ?? []).length;
    const digits = (w.match(/[0-9]/g) ?? []).length;
    if ((letters >= 2 && digits >= 1) || (letters >= 1 && digits >= 3)) out.add(w);
    else if (letters === 0 && digits >= 4 && !YEAR_TOKEN.test(w)) out.add(w);
  }
  return out;
}

/** Two names both carrying model numbers and sharing none. */
export function modelNumbersDisagree(a: string | null | undefined, b: string | null | undefined): boolean {
  const ma = modelNumberTokens(a);
  const mb = modelNumberTokens(b);
  return ma.size > 0 && mb.size > 0 && ![...ma].some((m) => mb.has(m));
}

export interface ProductSide {
  name?: string | null;
  fields?: Record<string, unknown> | null;
}

export type SameProductVerdict =
  /** An identifier field agrees: one product, whatever the names say. */
  | { verdict: "same"; by: "identifier" }
  /** An identifier field disagrees, or the names' model numbers do. */
  | { verdict: "different"; by: "identifier" | "model-number" }
  /** Nothing decisive: the caller's name rule decides. */
  | { verdict: "unknown" };

/**
 * The decisive part of "the same product", before any name rule: the
 * identifier fields first, the names' model numbers second. `unknown` hands
 * the call back to the surface's own overlap rule.
 */
export function sameProduct(a: ProductSide, b: ProductSide, roles?: Record<string, string | null | undefined> | null): SameProductVerdict {
  const ids = compareIdentifiers(a.fields, b.fields, roles);
  if (ids === "different") return { verdict: "different", by: "identifier" };
  if (ids === "same") return { verdict: "same", by: "identifier" };
  if (modelNumbersDisagree(a.name, b.name)) return { verdict: "different", by: "model-number" };
  return { verdict: "unknown" };
}
