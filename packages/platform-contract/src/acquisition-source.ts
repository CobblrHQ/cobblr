// VOCAB-ENUMERATION OK: the acquisition roles are this file's subject; it
// is the one place that knows a field with the acquired-from role is where
// the check looks, so the passes that stamp and read provenance need not.
//
// Where a thing was ACQUIRED, checked against what the purchase evidence
// says: the ONE rule, and the provenance that keeps a re-run honest.
//
// A brake rotor kit came off an eBay order ("from eBay, sold by detroitaxle"
// on the card) and its Acquired from chip said Facebook Marketplace (#3008).
// The receipt knew where it was bought; the field said somewhere else, and
// nothing compared the two. The same shape had already shipped once: a Lidl
// receipt line filled with Facebook Marketplace because that was the field's
// only choice (2026-09-06). That fix wrote the receipt's vendor over the
// model's answer on the next match, and left every row matched before it,
// and every confirm, exactly as they were.
//
// Two things live here, both pure, both read by the api and the web:
//
//   1. The consistency check. Purchase evidence (the order's marketplace or
//      the receipt's merchant, the seller on it, an import that named a
//      shop) against a populated acquisition-source field, with names
//      normalised so "eBay", "ebay.com" and "e-Bay" are one source.
//      A missing value is never a conflict. The seller is never a conflict
//      with the marketplace it sold on. A channel ("Gift", "Bought used") or
//      a place ("Garage") is not a source and never conflicts. Anything
//      else that names a different source is a contradiction, and a
//      contradiction is SURFACED on the served row (`source_conflict`,
//      beside `review_reason`), never resolved by picking a side quietly.
//
//   2. Per-field provenance: who put the value there.
//        evidence   a receipt, an order, an import that named the source
//        inference  a model or a rule guessing from what it could see
//        person     someone typed it, or corrected it
//      Person beats evidence beats inference. A re-run may overwrite an
//      inference with evidence, never a person's answer; an inference is
//      written only when no evidence exists and nothing is there already,
//      so a contradicted guess cannot come back once evidence has replaced
//      it or a person has answered over it.

import { RECEIPT_FROM_NAMES, RECEIPT_DATE_NAMES, PURCHASE_SELLER_NAMES } from "@cobblr/platform-contract/receipt-fact-names";

export type FieldProvenanceBy = "evidence" | "inference" | "person";

export interface FieldProvenance {
  by: FieldProvenanceBy;
  /** Which evidence or pass wrote it: "receipt", "order", "import", "router",
   *  "confirm". Words for a person reading the record, not a vocabulary code
   *  reads. */
  from?: string;
  at?: string;
  /** The value this one displaced, when a re-run replaced an inference with
   *  evidence: the contradiction stays on the record instead of vanishing. */
  replaced?: string;
  /** The role the field declared when it was filled ("acquired-from",
   *  "seller"), so the check can find the source field again on a row
   *  without reading the table. */
  role?: string;
}

/** The metadata key the stamps live under, on an inbox row and on the entity
 *  it becomes: `{ [field name]: FieldProvenance }`. */
export const FIELD_PROVENANCE_KEY = "field_provenance";

export type FieldProvenanceMap = Record<string, FieldProvenance>;

export function fieldProvenanceOf(meta: unknown): FieldProvenanceMap {
  const m = (meta ?? {}) as Record<string, unknown>;
  const raw = m[FIELD_PROVENANCE_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as FieldProvenanceMap) : {};
}

/**
 * May a writer of this standing put a value on a field that already carries
 * this provenance? The whole ordering, in one place:
 *   person    always: it is their record.
 *   evidence  over nothing or an inference; never over a person.
 *   inference only where nothing stands, and only when no evidence exists.
 */
export function mayWriteField(
  existing: FieldProvenance | undefined,
  incoming: FieldProvenanceBy,
  ctx: { hasEvidence: boolean; hasValue: boolean },
): boolean {
  if (incoming === "person") return true;
  if (existing?.by === "person") return false;
  if (incoming === "evidence") return true;
  return !ctx.hasEvidence && !ctx.hasValue && existing === undefined;
}

// ── Purchase evidence on a row ───────────────────────────────────────────

export type EvidenceSource = "receipt" | "order" | "import";

export interface PurchaseEvidence {
  /** The marketplace or shop the purchase was made with: the receipt's
   *  merchant, the order's marketplace. Null when nothing said. */
  source: string | null;
  /** Who sold it there, when the evidence names one apart from the source. */
  seller: string | null;
  from: EvidenceSource | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * What the row's own record says about where it was bought. Reads the keys
 * a receipt parse stamps (receipt_vendor / receipt_seller), the keys an
 * order import stamps (order_marketplace / order_vendor / order_seller), and
 * an import provenance that named a shop (import_provenance.vendor or
 * .marketplace; `.source` names the SYSTEM the rows came from and is not a
 * place anything was bought).
 */
export function purchaseEvidenceOf(meta: unknown): PurchaseEvidence {
  const m = (meta ?? {}) as Record<string, unknown>;
  const receiptVendor = str(m.receipt_vendor);
  const receiptSeller = str(m.receipt_seller);
  if (receiptVendor || receiptSeller) {
    return { source: receiptVendor ?? receiptSeller, seller: receiptSeller && receiptSeller !== receiptVendor ? receiptSeller : null, from: "receipt" };
  }
  const orderSource = str(m.order_marketplace) ?? str(m.order_vendor);
  const orderSeller = str(m.order_seller);
  if (orderSource || orderSeller) {
    return { source: orderSource ?? orderSeller, seller: orderSeller && orderSeller !== orderSource ? orderSeller : null, from: "order" };
  }
  const prov = (m.import_provenance ?? null) as Record<string, unknown> | null;
  const importSource = str(prov?.marketplace) ?? str(prov?.vendor);
  const importSeller = str(prov?.seller);
  if (importSource || importSeller) {
    return { source: importSource ?? importSeller, seller: importSeller && importSeller !== importSource ? importSeller : null, from: "import" };
  }
  return { source: null, seller: null, from: null };
}

// ── Names ────────────────────────────────────────────────────────────────

// VOCAB-ENUMERATION OK: the aliases people write for one marketplace are
// data about names, not a rule branching on a role.
/** Spellings that mean one source. Keys and values are canonical (see
 *  canonicalSourceName): lowercase, no punctuation, no domain tail. */
const SOURCE_ALIASES: Record<string, string> = {
  fb: "facebook",
  amzn: "amazon",
  ali: "aliexpress",
  craigs: "craigslist",
  lowe: "lowes",
};

/** Tokens that qualify a source without naming one: dropped before two
 *  names are compared, so "Amazon Marketplace" is "Amazon" and "The Home
 *  Depot Store" is "Home Depot". */
const GENERIC_TOKENS = new Set([
  "the", "a", "an", "and", "from", "via", "by", "at", "of", "my", "our",
  "marketplace", "market", "store", "stores", "shop", "shops", "online", "official", "website", "site", "app",
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh", "plc", "pty", "srl", "sa", "ag",
]);

const DOMAIN_TAIL = /\.(?:com|co\.uk|co|net|org|io|ca|de|fr|uk|au|us|nl|es|it|shop|store|app|xyz)(?=$|[/\s?#])/g;

/**
 * One source name as a comparable key. Case, accents, punctuation, a URL
 * scheme or path, a domain tail, a leading "www." and the generic and
 * corporate tokens are all gone; what remains is the name squashed to
 * letters and digits, run through the alias table. "eBay", "ebay.com",
 * "https://www.ebay.co.uk/itm/1" and "e-Bay Marketplace" are all "ebay".
 */
export function canonicalSourceName(raw: string): string {
  let s = raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(DOMAIN_TAIL, "");
  s = s.split(/[/?#]/)[0] ?? s;
  s = s.replace(/['’`]/g, "");
  const tokens = s.split(/[^a-z0-9]+/).filter((t) => t && !GENERIC_TOKENS.has(t));
  const squashed = tokens.join("");
  return SOURCE_ALIASES[squashed] ?? squashed;
}

/** The comparable tokens of a name, for the containment rule below. */
function sourceTokens(raw: string): string[] {
  const s = raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(DOMAIN_TAIL, "").replace(/['’`]/g, "");
  return s.split(/[^a-z0-9]+/).filter((t) => t && !GENERIC_TOKENS.has(t)).map((t) => SOURCE_ALIASES[t] ?? t);
}

/**
 * Do two written names mean one source? Equal once canonical, or one is the
 * other with more words around it ("Facebook" beside "Facebook Marketplace",
 * "eBay" beside "eBay (detroitaxle)", "KC Tool" beside "KC Tool Inc").
 */
export function sameSource(a: string, b: string): boolean {
  const ca = canonicalSourceName(a);
  const cb = canonicalSourceName(b);
  if (!ca || !cb) return false;
  if (ca === cb) return true;
  const ta = sourceTokens(a);
  const tb = sourceTokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const longSet = new Set(long);
  if (short.every((t) => longSet.has(t))) return true;
  // The same words written as one ("bestbuy") and as two ("Best Buy").
  const sa = ta.join("");
  const sb = tb.join("");
  return sa.length >= 4 && sb.length >= 4 && (sa.startsWith(sb) || sb.startsWith(sa));
}

// VOCAB-ENUMERATION OK: the words people put in a source field that do not
// name a source. Data, read by one predicate.
/** How or where something came to you, rather than who it came from. A value
 *  made only of these never contradicts a receipt: "Gift" beside an eBay
 *  order is a story, not a disagreement. */
const CHANNEL_OR_PLACE_TOKENS = new Set([
  // channels
  "new", "used", "secondhand", "second", "hand", "preowned", "pre", "owned", "bought", "purchased", "gift", "gifted", "present",
  "inherited", "found", "made", "homemade", "diy", "built", "self", "online", "in", "person", "instore", "local", "locally",
  "retail", "wholesale", "salvage", "salvaged", "scrap", "borrowed", "rented", "rental", "free", "trade", "traded", "swap",
  "swapped", "thrift", "thrifted", "garage", "yard", "estate", "sale", "car", "boot", "flea", "auction", "unknown", "n",
  "none", "other", "misc", "various", "work", "family", "friend", "friends", "neighbour", "neighbor", "school", "club",
  "mom", "mum", "dad", "mother", "father", "parents", "grandma", "grandpa", "grandmother", "grandfather", "brother",
  "sister", "aunt", "uncle", "cousin", "wife", "husband", "partner", "son", "daughter", "kids", "colleague",
  // places
  "home", "house", "basement", "attic", "shed", "closet", "office", "kitchen", "bedroom", "workshop", "storage", "unit",
  "locker", "warehouse", "site", "field", "van", "truck",
]);

/** Does this value describe a channel or a place rather than name a source? */
export function isChannelOrPlace(value: string): boolean {
  const tokens = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !GENERIC_TOKENS.has(t));
  if (!tokens.length) return true;
  return tokens.every((t) => CHANNEL_OR_PLACE_TOKENS.has(t));
}

// ── The check ────────────────────────────────────────────────────────────

export interface SourceConflict {
  /** The field that holds the contradicted value. */
  field: string;
  value: string;
  /** What the evidence says instead: the marketplace or merchant. */
  evidence: string;
  seller: string | null;
  from: EvidenceSource;
}

/**
 * Does a populated acquisition-source value contradict the purchase
 * evidence? Null when there is nothing to compare (no value, no evidence),
 * when the two are one source, when the value is the seller, or when the
 * value is a channel or a place rather than a source.
 */
export function acquisitionSourceConflict(field: string, value: unknown, evidence: PurchaseEvidence): SourceConflict | null {
  const v = str(value);
  if (!v) return null;
  const known = evidence.source ?? evidence.seller;
  if (!known || !evidence.from) return null;
  if (isChannelOrPlace(v)) return null;
  if (sameSource(v, known)) return null;
  if (evidence.seller && sameSource(v, evidence.seller)) return null;
  if (evidence.source && sameSource(v, evidence.source)) return null;
  return { field, value: v, evidence: known, seller: evidence.seller, from: evidence.from };
}

/** The sentence the row shows for a conflict, where Add would be. */
export function sourceConflictWords(c: SourceConflict, label?: string): string {
  const what = label ?? c.field.replace(/_/g, " ");
  const said = c.from === "receipt" ? "the receipt says" : c.from === "order" ? "the order says" : "the import says";
  const seller = c.seller ? ` (sold by ${c.seller})` : "";
  return `${what} says ${c.value}, but ${said} ${c.evidence}${seller}; check it`;
}

// ── Which field ──────────────────────────────────────────────────────────

/** A field as the check needs it: a name, and the role when the table
 *  declares one. Structural, so a menu field, a field def and a bare name
 *  all fit. */
export interface SourceFieldLike {
  name: string;
  field_role?: string | null;
}

/** Is this the field that says where a thing was acquired? By ROLE when the
 *  table declares one; by the names people give it otherwise. */
export function isAcquiredFromField(f: SourceFieldLike): boolean {
  if (f.field_role === "acquired-from") return true;
  if (f.field_role) return false;
  return RECEIPT_FROM_NAMES.test(f.name.trim().toLowerCase());
}

/** Is this the field that says who sold it? */
export function isSellerField(f: SourceFieldLike): boolean {
  if (f.field_role === "seller") return true;
  if (f.field_role) return false;
  return PURCHASE_SELLER_NAMES.test(f.name.trim().toLowerCase());
}

/** Is this the field that says when it was acquired? */
export function isAcquiredOnField(f: SourceFieldLike): boolean {
  if (f.field_role === "acquired-on") return true;
  if (f.field_role) return false;
  return RECEIPT_DATE_NAMES.test(f.name.trim().toLowerCase());
}

/** The purchase role a field plays, declared or implied by its name, for
 *  the provenance stamp that says which field the check should read again.
 *  Null for a field that is none of these. */
export function purchaseFieldRole(f: SourceFieldLike): "acquired-from" | "acquired-on" | "seller" | null {
  if (isAcquiredFromField(f)) return "acquired-from";
  if (isAcquiredOnField(f)) return "acquired-on";
  if (isSellerField(f)) return "seller";
  return null;
}

/** A stored candidate list as an array, whatever shape it arrived in. */
function candidateList(raw: unknown): Array<{ fields?: Record<string, unknown> }> {
  let list = raw;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return [];
    }
  }
  return Array.isArray(list) ? (list as Array<{ fields?: Record<string, unknown> }>) : [];
}

export interface SourceConflictRow {
  suggested_candidates?: unknown;
  suggested_metadata?: unknown;
}

/**
 * The conflict a row carries, read off its top route and its own record.
 * Which field is the source field is decided by the provenance stamps when
 * the match left any (they name the field by role), and by the field's name
 * otherwise, so a row matched before the stamps existed is still checked.
 * DERIVED on the way out, never stored: a row that contradicts its receipt
 * says so the moment this is deployed, with no re-run.
 */
export function scanSourceConflict(row: SourceConflictRow): SourceConflict | null {
  const top = candidateList(row.suggested_candidates)[0];
  const fields = top?.fields;
  if (!fields) return null;
  const evidence = purchaseEvidenceOf(row.suggested_metadata);
  if (!evidence.from) return null;
  const stamps = fieldProvenanceOf(row.suggested_metadata);
  for (const name of Object.keys(fields)) {
    const stamped = stamps[name];
    const isFrom = stamped?.role ? stamped.role === "acquired-from" : isAcquiredFromField({ name });
    if (!isFrom) continue;
    const c = acquisitionSourceConflict(name, fields[name], evidence);
    if (c) return c;
  }
  return null;
}
