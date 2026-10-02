// VOCAB-ENUMERATION OK: this is the EXTRACTOR, and naming the concepts is its
// entire job. It turns receipt-shaped metadata into role-tagged facts, which is
// the one place that must know a vendor is a "where I got it" and a net price
// is a "what it cost". Everything downstream of it is generic and must stay so:
// the matcher never learns any of these names.
//
// It lives in its own file rather than inside the confirm route so that
// knowledge is small, named, and visible. Buried in a 5500-line route handler
// it reads as incidental; here it reads as the boundary it is.
//
// See docs/design-decisions/arrivals.md.

import { FIELD_ROLE_VALUES, type FieldRole, type RoledFacts } from "@cobblr/platform-contract";

/** The receipt keys `materializeReceiptLines` stamps on an inbox item. */
export interface ReceiptMeta {
  receipt_vendor?: unknown;
  receipt_seller?: unknown;
  receipt_date?: unknown;
  net_price?: unknown;
  receipt_line_count?: unknown;
  line_net?: unknown;
  line_total?: unknown;
  /** Facts a document reader established about this one thing, already
   *  keyed by role (a bill of sale's VIN, year and odometer). */
  line_facts?: unknown;
  /** The document's own checks that failed (document-checks.ts): a value
   *  that failed one is never a fact (#4633). */
  check_fields?: unknown;
}

/** Which facts a failed check takes back: the words a check names
 *  (scan-triage CHECK_FIELD_WORDS) to the roles their values fill. */
const DOUBT_TAKES: Record<string, readonly FieldRole[]> = {
  seller: ["acquired-from", "seller"],
  price: ["acquired-for"],
  total: ["acquired-for"],
  deposit: ["acquired-for"],
  vin: ["identifier"],
  year: ["year-made"],
};

/** The check a held role failed, in the card's words: the first of the
 *  doubted checks that takes it back. */
export function checkWordFor(role: string, doubted: Iterable<string>): string {
  const d = [...doubted];
  return d.find((w) => (DOUBT_TAKES[w] ?? []).includes(role as FieldRole)) ?? Object.keys(DOUBT_TAKES).find((w) => DOUBT_TAKES[w]!.includes(role as FieldRole)) ?? role;
}

/** Did a check doubt who sold it? */
export function sellerDoubted(doubted: ReadonlySet<string>): boolean {
  return doubted.has("seller");
}

/** Did a check doubt what it cost? */
export function priceDoubted(doubted: ReadonlySet<string>): boolean {
  return doubted.has("price") || doubted.has("total") || doubted.has("deposit");
}

/** The check words a row's failed checks name ("seller", "price"). */
export function doubtedChecks(meta: { check_fields?: unknown } | null | undefined): Set<string> {
  const f = (meta?.check_fields as { fields?: unknown } | null | undefined)?.fields;
  return new Set(Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : []);
}

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "" ? null : s;
};

/**
 * What this purchase WAS, keyed by meaning.
 *
 * Only facts we actually established: an absent key is absent, never a guess.
 * The caller hands the result to the generic matcher, which decides where each
 * one lands based on what the workspace declared.
 */
export function receiptFacts(meta: ReceiptMeta | null | undefined): RoledFacts {
  return splitDoubtedFacts(meta).facts;
}

/** The facts, and the ones a failed check held back: shown under "Please
 *  check" with what was read, and written nowhere (#4633). The dealer's
 *  "sells/leases this vehicle 'as is' and hereby" failed the seller check
 *  and still became Bought from on the merge. */
export function splitDoubtedFacts(meta: ReceiptMeta | null | undefined): { facts: RoledFacts; held: RoledFacts } {
  const all = allReceiptFacts(meta);
  const doubted = doubtedChecks(meta);
  const facts: RoledFacts = {};
  const held: RoledFacts = {};
  const out = new Set<FieldRole>([...doubted].flatMap((w) => [...(DOUBT_TAKES[w] ?? [])]));
  for (const [role, v] of Object.entries(all) as Array<[FieldRole, string | number]>) (out.has(role) ? held : facts)[role] = v;
  return { facts, held };
}

function allReceiptFacts(meta: ReceiptMeta | null | undefined): RoledFacts {
  const facts: RoledFacts = {};
  if (!meta) return facts;

  const vendor = str(meta.receipt_vendor);
  const seller = str(meta.receipt_seller);

  // Where you got it: the shop, or the person when there is no shop. A
  // marketplace has both, and the marketplace is the durable, groupable answer.
  const from = vendor ?? seller;
  if (from) facts["acquired-from"] = from;

  // WHO sold it, only when it is a second fact. Echoing the vendor back would
  // make a clarifier that reads "eBay · eBay".
  if (seller && seller !== vendor) facts.seller = seller;

  const date = str(meta.receipt_date);
  if (date) facts["acquired-on"] = date;

  // What THIS item cost - the line's own number, never the basket's. The
  // receipt-level net_price is subtotal minus discounts for the whole order;
  // stamping it per line recorded a 20-line grocery run as twenty items that
  // each cost the entire basket. The order-level number is only an answer when
  // the receipt HAS one line, which is when the two mean the same thing.
  const money = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const lineCount = money(meta.receipt_line_count);
  const price =
    money(meta.line_net) ??
    money(meta.line_total) ??
    (lineCount === 1 ? money(meta.net_price) : null);
  if (price !== null) facts["acquired-for"] = price;

  // What a document reader said about the thing itself. Only roles the
  // vocabulary knows, only plain values; the receipt-level facts above
  // stand where both have one.
  const line = meta.line_facts;
  if (line && typeof line === "object" && !Array.isArray(line)) {
    for (const [role, v] of Object.entries(line as Record<string, unknown>)) {
      if (!(FIELD_ROLE_VALUES as readonly string[]).includes(role) || role in facts) continue;
      if (typeof v === "string" ? v.trim() !== "" : typeof v === "number" && Number.isFinite(v)) {
        facts[role as FieldRole] = v as string | number;
      }
    }
  }

  return facts;
}
