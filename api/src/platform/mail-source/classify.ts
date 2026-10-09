// Is this email an order, a parcel, or neither? Decided by content, never by
// sender alone (#5462): many stores run on Shopify and mail from their own
// servers, so a sender filter missed them. Strongest signal first, and no
// model anywhere in here: when nothing below decides, the answer is "ask-ai"
// and the caller chooses whether to (the mailbox check never does).
//
//   1. schema.org markup (JSON-LD or microdata Order / ParcelDelivery /
//      Invoice): the data Gmail's own "Expected by" chip reads. Structured,
//      so it is read straight.
//   2. A shop platform's fingerprint, whatever the sender: Shopify's order
//      links, click links and image host; WooCommerce, BigCommerce,
//      Squarespace, Amazon, eBay. A fingerprint says WHO built the email,
//      not that it is an order, so it decides only beside an order cue.
//   3. Heuristics: an order confirmation's subject, a shipping notice, a
//      return, an order number, a carrier's tracking number.
//
// A store's marketing carries the same fingerprints and no order cue, so it
// is "not-order". Pure.

import { classifyReturnEmail, classifyShipmentEmail, isOrderConfirmation, trackingNumbersIn, promisedDateIn } from "../shipment-email.js";

export type MailVerdict = "order" | "shipment" | "not-order" | "ask-ai";
export type DecidedBy = "schema.org" | "platform" | "heuristics" | "remembered" | "none";

export interface MailSignals {
  schema: string | null;
  platform: string | null;
  orderNumber: string | null;
  tracking: string[];
  orderSubject: boolean;
  marketing: boolean;
  purchasesLabel: boolean;
}

export interface MailDecision {
  verdict: MailVerdict;
  by: DecidedBy;
  /** "strong": structured data or a platform's own order link; "weak": one
   *  heuristic cue alone. The review lists weak hits as likely false ones. */
  strength: "strong" | "weak" | null;
  /** What it would file. */
  found: { merchant: string | null; orderNumber: string | null; tracking: Array<{ number: string; carrier: string | null }>; expected: string | null; items: number | null };
  signals: MailSignals;
}

export interface MailInput {
  from_email?: string | null;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  /** Gmail's label ids, when read from Gmail (CATEGORY_PURCHASES and so on). */
  labels?: readonly string[];
}

type Json = Record<string, unknown>;

function typesOf(node: Json): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string").map((x) => x.replace(/^https?:\/\/schema\.org\//, ""));
}

function walkLd(value: unknown, into: Json[]): void {
  if (Array.isArray(value)) for (const v of value) walkLd(v, into);
  else if (value && typeof value === "object") {
    const node = value as Json;
    if (node["@type"]) into.push(node);
    if (node["@graph"]) walkLd(node["@graph"], into);
  }
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object") return str((v as Json).name ?? (v as Json)["@id"]);
  return null;
}

interface SchemaFacts { type: string; merchant: string | null; orderNumber: string | null; tracking: Array<{ number: string; carrier: string | null }>; expected: string | null; items: number | null }

/** schema.org Order / ParcelDelivery / Invoice in an email's html: JSON-LD
 *  first, then microdata's itemprops. Null when there is none. */
export function schemaFacts(html: string): SchemaFacts | null {
  const nodes: Json[] = [];
  const ld = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = ld.exec(html); m; m = ld.exec(html)) {
    try {
      walkLd(JSON.parse((m[1] ?? "").trim()), nodes);
    } catch {
      // A malformed block is not markup to read.
    }
  }
  const wanted = (n: Json) => typesOf(n).find((t) => t === "Order" || t === "ParcelDelivery" || t === "Invoice");
  const node = nodes.find(wanted);
  if (node) {
    const type = wanted(node)!;
    const delivery = (type === "ParcelDelivery" ? node : (node.orderDelivery as Json | undefined)) ?? null;
    const order = (type === "Order" ? node : (node.partOfOrder as Json | undefined)) ?? null;
    const tracking = delivery && str(delivery.trackingNumber) ? [{ number: str(delivery.trackingNumber)!.replace(/\s+/g, ""), carrier: str(delivery.carrier) }] : [];
    const offers = order?.acceptedOffer ?? delivery?.itemShipped;
    return {
      type,
      merchant: str(order?.merchant ?? order?.seller ?? node.provider ?? node.merchant),
      orderNumber: str(order?.orderNumber ?? node.orderNumber ?? node.confirmationNumber),
      tracking,
      expected: str(delivery?.expectedArrivalUntil ?? delivery?.expectedArrivalFrom)?.slice(0, 10) ?? null,
      items: Array.isArray(offers) ? offers.length : offers ? 1 : null,
    };
  }
  const micro = /itemtype\s*=\s*["']https?:\/\/schema\.org\/(Order|ParcelDelivery|Invoice)["']/i.exec(html);
  if (!micro) return null;
  const prop = (name: string) => {
    const c = new RegExp(`itemprop\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, "i").exec(html) ?? new RegExp(`itemprop\\s*=\\s*["']${name}["'][^>]*>([^<]+)<`, "i").exec(html);
    return c?.[1]?.trim() || null;
  };
  const number = prop("trackingNumber");
  return {
    type: micro[1]!,
    merchant: prop("name"),
    orderNumber: prop("orderNumber"),
    tracking: number ? [{ number: number.replace(/\s+/g, ""), carrier: prop("carrier") }] : [],
    expected: prop("expectedArrivalUntil")?.slice(0, 10) ?? null,
    items: null,
  };
}

const PLATFORMS: Array<{ name: string; mark: RegExp; orderLink: RegExp }> = [
  { name: "shopify", mark: /cdn\.shopify\.com|myshopify\.com|shopifyemail\.com|\/_t\/c\/v\d|\/account\/orders\/|\/orders\/[0-9a-f]{32}\/authenticate/i, orderLink: /\/account\/orders\/|\/orders\/[0-9a-f]{32}\/authenticate/i },
  { name: "woocommerce", mark: /woocommerce|\/my-account\/view-order\//i, orderLink: /\/my-account\/view-order\//i },
  { name: "bigcommerce", mark: /bigcommerce|account\.php\?action=view_order/i, orderLink: /account\.php\?action=view_order/i },
  { name: "squarespace", mark: /squarespace|static1\.squarespace\.com/i, orderLink: /\/commerce\/orders\//i },
  { name: "amazon", mark: /@(?:[a-z0-9-]+\.)*amazon\.[a-z.]+$/i, orderLink: /orderID=|order-details|\/gp\/your-account\/order/i },
  { name: "ebay", mark: /@(?:[a-z0-9-]+\.)*ebay\.[a-z.]+$/i, orderLink: /\/ord\/show|purchase-history|vod\/FetchOrderDetails/i },
];

const ORDER_NUMBER = /\b(?:order|confirmation)\s*(?:#|no\.?|number|id)[:\s]*#?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,})\b|#\s?(\d{4,})\b/i;
const MARKETING = /\b(\d{1,2}% off|sale ends|shop now|new arrivals|limited time|use code|coupon|newsletter|flash sale|deal of the day|back in stock|you might (?:also )?like|recommended for you)\b/i;
const ORDER_WORDS = /\b(order|shipped|shipment|on (?:the|its) way|delivered|out for delivery|tracking|receipt|invoice|refund|return)\b/i;

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
}

/** The decision for one email. `remembered` is a person's earlier verdict
 *  for this sender, which wins over every rule. */
export function classifyMail(mail: MailInput, remembered?: "order" | "not-order" | null, now: Date = new Date()): MailDecision {
  const subject = (mail.subject ?? "").replace(/^(?:fwd?|fw|re):\s*/i, "").trim();
  const html = mail.html ?? "";
  const plain = mail.text?.trim() ? mail.text : stripHtml(html);
  const from = (mail.from_email ?? "").toLowerCase();
  const purchasesLabel = (mail.labels ?? []).includes("CATEGORY_PURCHASES");
  const schema = html ? schemaFacts(html) : null;
  const platform = PLATFORMS.find((p) => p.mark.test(html) || p.mark.test(from)) ?? null;
  const orderLink = platform ? platform.orderLink.test(html) : false;
  const haystack = `${subject}\n${plain}`;
  const orderNumber = ORDER_NUMBER.exec(haystack)?.slice(1).find(Boolean) ?? null;
  const tracking = trackingNumbersIn(haystack).map((t) => ({ number: t.number, carrier: t.carrier as string | null }));
  const orderSubject = isOrderConfirmation(subject);
  const shipment = classifyShipmentEmail({ subject, text: plain, html, from_email: from });
  const returned = classifyReturnEmail({ subject, text: plain, html, from_email: from });
  const marketing = MARKETING.test(haystack) && !orderNumber && tracking.length === 0;
  const signals: MailSignals = { schema: schema?.type ?? null, platform: platform?.name ?? null, orderNumber, tracking: tracking.map((t) => t.number), orderSubject, marketing, purchasesLabel };
  const found = (over: Partial<MailDecision["found"]> = {}): MailDecision["found"] => ({
    merchant: null,
    orderNumber,
    tracking,
    expected: promisedDateIn(haystack, now),
    items: null,
    ...over,
  });
  const decide = (verdict: MailVerdict, by: DecidedBy, strength: MailDecision["strength"], f = found()): MailDecision => ({ verdict, by, strength, found: f, signals });

  if (remembered) return decide(remembered === "order" ? (tracking.length ? "shipment" : "order") : "not-order", "remembered", remembered === "order" ? "strong" : null);

  if (schema) {
    const f = found({
      merchant: schema.merchant,
      orderNumber: schema.orderNumber ?? orderNumber,
      tracking: schema.tracking.length ? schema.tracking : tracking,
      expected: schema.expected ?? promisedDateIn(haystack, now),
      items: schema.items,
    });
    return decide(schema.type === "ParcelDelivery" || f.tracking.length ? "shipment" : "order", "schema.org", "strong", f);
  }

  const shipping = Boolean(shipment) || (tracking.length > 0 && ORDER_WORDS.test(subject));
  const cue = orderSubject || shipping || Boolean(returned) || Boolean(orderNumber && ORDER_WORDS.test(subject));
  if (platform && (orderLink || cue)) {
    if (marketing && !orderLink && !shipping && !orderSubject) return decide("not-order", "platform", null);
    return decide(shipping ? "shipment" : "order", "platform", orderLink || orderNumber || tracking.length ? "strong" : "weak");
  }
  if (marketing) return decide("not-order", "heuristics", null);
  if (shipping) return decide("shipment", "heuristics", tracking.length ? "strong" : "weak");
  if (orderSubject || returned) return decide("order", "heuristics", orderNumber ? "strong" : "weak");
  if (orderNumber && ORDER_WORDS.test(subject)) return decide("order", "heuristics", "weak");
  if (purchasesLabel) return decide("ask-ai", "none", null);
  return decide("not-order", "none", null);
}
