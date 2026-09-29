// What a marketplace listing screenshot printed about the purchase (#3853).
//
// A screenshot of a sold listing ("Sold · CR-10 3D printer · $20 · Listed 12
// weeks ago in Parsippany, NJ · Used - Good · seller Vdd Vdd") was recognised
// as a listing and then read as a product photo: the item was named, and the
// shop, the price and the seller, all printed on the page, were thrown away.
// A listing is purchase evidence the same way a receipt is, so the identify
// reply now carries what the page printed (`listing`, verbatim, never a
// guess), it rides on the row under LISTING_KEY, and the facts writer
// (receipt-candidate-facts.ts) files it into the table's own acquired-from,
// seller, price and condition fields as evidence, from "listing".

/** The row's metadata key the listing read lives under. The platform
 *  contract's purchaseEvidenceOf reads the same key. */
export const LISTING_KEY = "listing";

export interface ListingRead {
  marketplace: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  seller: string | null;
  location: string | null;
  condition: string | null;
  sold: boolean | null;
  /** How long ago it was listed, as printed ("12 weeks ago"). Not a date:
   *  when it was listed is not when it was bought. */
  listed: string | null;
}

const clean = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s || /^(null|none|n\/a|unknown)$/i.test(s)) return null;
  return s.slice(0, max);
};

/** A price as a number: a number stays one, "$1,250.00" becomes 1250. */
function priceOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The model's `listing` answer, shaped. Null when it is absent or says
 *  nothing a purchase could use: a listing with no marketplace, no seller
 *  and no price is not evidence of anything. Pure. */
export function parseListing(raw: unknown): ListingRead | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const currency = clean(r.currency, 8);
  const read: ListingRead = {
    marketplace: clean(r.marketplace, 80),
    title: clean(r.title),
    price: priceOf(r.price),
    currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null,
    seller: clean(r.seller, 80),
    location: clean(r.location, 120),
    condition: clean(r.condition, 60),
    sold: typeof r.sold === "boolean" ? r.sold : null,
    listed: clean(r.listed, 60),
  };
  if (!read.marketplace && !read.seller && read.price === null) return null;
  return read;
}

/** The listing on a row's metadata, or null. */
export function listingOf(meta: unknown): ListingRead | null {
  const raw = (meta as Record<string, unknown> | null)?.[LISTING_KEY];
  return parseListing(raw);
}
