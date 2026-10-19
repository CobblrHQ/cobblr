import { colourFromName } from "@cobblr/platform-contract/colour";

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

/** A conservative identity fallback for old/imported fields whose role has
 *  not been set yet. Codes such as VINs, IMEIs and asset tags are long and
 *  contain both letters and digits; prose, dates and ordinary numbers are
 *  deliberately excluded. */
export function isCodeLikeIdentifier(v: unknown): boolean {
  if (typeof v !== "string" && typeof v !== "number") return false;
  const raw = String(v).trim();
  if (!/^[a-z0-9._\-/]+$/i.test(raw)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(raw)) return false;
  const key = identifierKey(v);
  return !!key && key.length >= 8 && /[a-z]/.test(key) && /\d/.test(key);
}

/** Every value in a field bag that identifies the record. Declared roles and
 *  well-known field names are authoritative; old unroled fields get the
 *  conservative code-shape fallback above. Values are returned as written,
 *  de-duplicated by their comparison key. */
export function identifierValues(
  fields: Record<string, unknown> | null | undefined,
  roles?: Record<string, string | null | undefined> | null,
): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const key = identifierKey(value);
    if (!key) continue;
    const named = isIdentifierField(name, roles?.[name] ?? null) && identifies(name, key);
    if (!named && !isCodeLikeIdentifier(value)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(String(value).trim());
  }
  return values;
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

/** A measurement after a number: "3.5 oz" is a size, never a version. */
const UNIT_AFTER = /^\s*(?:oz|ounces?|ml|l|lb|lbs|pounds?|kg|g|grams?|mm|cm|m|in|inch(?:es)?|ft|"|'|v|volts?|a|amps?|w|watts?|ah|mah|gal|qt|%|x)\b/;

/** The VERSION marks a name carries: a decimal version ("0.1", "2.4.1"), a
 *  v-number ("v2", "V2.1") or a mark ("Mk3", "MK 4", "Mk3S"). The model-number
 *  rule above cannot see them: it drops punctuation and short words, so a
 *  Voron 0.2 and a Voron 0.1 read as one printer (#3909), and so did a Prusa
 *  Mk3 and Mk4. A number followed by a unit ("3.5 oz") is a size, not a
 *  version. */
export function versionTokens(s: string | null | undefined): Set<string> {
  const out = new Set<string>();
  const t = (s ?? "").toLowerCase();
  for (const m of t.matchAll(/(?<![\w.])(\d+\.\d+(?:\.\d+)*)(?![\w.])/g)) {
    if (UNIT_AFTER.test(t.slice((m.index ?? 0) + m[0].length))) continue;
    out.add(m[1]!);
  }
  for (const m of t.matchAll(/\bv(\d+(?:\.\d+)*)\b/g)) out.add(`v${m[1]}`);
  for (const m of t.matchAll(/\bmk\s?(\d+[a-z]?|i{1,3}v?|iv)\b/g)) out.add(`mk${m[1]}`);
  return out;
}

/** Two names that both carry a version and share none. */
export function versionsDisagree(a: string | null | undefined, b: string | null | undefined): boolean {
  const va = versionTokens(a);
  const vb = versionTokens(b);
  return va.size > 0 && vb.size > 0 && ![...va].some((v) => vb.has(v));
}

/** Two names that carry the same version: evidence they are one product. */
export function versionsAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const va = versionTokens(a);
  const vb = versionTokens(b);
  return [...va].some((v) => vb.has(v));
}

/** A store's name for one variant: "TITLE - US / 10KG / white", the shape
 *  Shopify and most carts print on an order line (the product's title, a
 *  dash, then the chosen options). Null when the name has no such tail. */
export function storeVariantOf(s: string | null | undefined): { base: string; options: string[] } | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.*\S)\s+[-\u2013\u2014]\s+(\S.*)$/);
  if (!m) return null;
  const options = m[2]!.split("/").map((o) => o.trim().toLowerCase()).filter(Boolean);
  return options.length ? { base: m[1]!.toLowerCase(), options } : null;
}

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[a-z0-9][a-z0-9.-]*/g) ?? [];

/** Two names for different variants of one product (#5719): the same title
 *  with different options ("… / Multicolor" and "… / white"), or one name's
 *  options and the other's extra word disagreeing ("… - US / 10KG /
 *  Multicolor" and "… 1.75mm White"). The words they share are the
 *  product's, so a word-overlap rule calls them one thing; the options are
 *  what was bought. Unknown (false) when either name says nothing about it. */
export function variantsDisagree(a: string | null | undefined, b: string | null | undefined): boolean {
  // A typed name has no store option tail. Disjoint explicit colours still
  // veto overlap; an absent colour says nothing, and aliases share a swatch.
  const colours = (name: string | null | undefined) => new Set((name ?? "").split(/[^a-z]+/i).map(colourFromName).filter((c): c is string => !!c));
  const ca = colours(a);
  const cb = colours(b);
  if (ca.size && cb.size && ![...ca].some((c) => cb.has(c))) return true;
  const va = storeVariantOf(a);
  const vb = storeVariantOf(b);
  if (va && vb) return va.base === vb.base && va.options.join("/") !== vb.options.join("/");
  const one = va ?? vb;
  const other = (va ? b : a) ?? "";
  if (!one) return false;
  const base = new Set(wordsOf(one.base));
  const extra = wordsOf(other).filter((w) => !base.has(w));
  // Only a name that carries the whole title (three words or more, so a
  // short one like "WD-40" proves nothing) plus words of its own; the title
  // alone names no variant.
  const has = new Set(wordsOf(other));
  if (base.size < 3 || extra.length === 0 || ![...base].every((w) => has.has(w))) return false;
  const options = new Set(one.options.flatMap(wordsOf));
  return !extra.some((w) => options.has(w));
}

/** Words that say what a thing is MADE of, as one material each. Only words
 *  that name a material wherever they appear: "wood" (a wood screw), "glass"
 *  (glass cleaner), "iron" (a soldering iron) and "silk" (silk PLA) name a
 *  use or a finish as often, and stay out. */
const MATERIAL_WORDS: Record<string, string> = {
  brass: "brass",
  bronze: "bronze",
  copper: "copper",
  steel: "steel",
  stainless: "stainless",
  aluminium: "aluminium",
  aluminum: "aluminium",
  titanium: "titanium",
  zinc: "zinc",
  nickel: "nickel",
  nylon: "nylon",
  plastic: "plastic",
  rubber: "rubber",
  silicone: "silicone",
  cotton: "cotton",
  wool: "wool",
  acrylic: "acrylic",
  polyester: "polyester",
  pla: "pla",
  petg: "petg",
  abs: "abs",
  asa: "asa",
  tpu: "tpu",
};

/** The materials a side states, in its name or its `material` field. Stainless
 *  steel is its own material, not more steel. */
export function materialsOf(side: { name?: string | null; fields?: Record<string, unknown> | null }): Set<string> {
  const f = side.fields ?? {};
  const meta = f.metadata && typeof f.metadata === "object" ? (f.metadata as Record<string, unknown>) : {};
  const field = [f.material, meta.material].filter((v): v is string => typeof v === "string").join(" ");
  const out = new Set<string>();
  for (const w of `${side.name ?? ""} ${field}`.toLowerCase().replace(/pet-g/g, "petg").split(/[^a-z]+/)) {
    const m = MATERIAL_WORDS[w];
    if (m) out.add(m);
  }
  if (out.has("stainless")) out.delete("steel");
  return out;
}

/** Two sides that both state a material and share none (#7523): a steel
 *  washer is not more of the brass washer, however many words the names
 *  share. A side that states none says nothing. */
export function materialsDisagree(a: ProductSide, b: ProductSide): boolean {
  const ma = materialsOf(a);
  const mb = materialsOf(b);
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
  | { verdict: "different"; by: "identifier" | "model-number" | "version" | "variant" | "material" }
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
  if (versionsDisagree(a.name, b.name)) return { verdict: "different", by: "version" };
  if (variantsDisagree(a.name, b.name)) return { verdict: "different", by: "variant" };
  if (materialsDisagree(a, b)) return { verdict: "different", by: "material" };
  return { verdict: "unknown" };
}
