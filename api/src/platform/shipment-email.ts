// A shipping notification, read as a CARRIER EVENT.
//
// Amazon has no consumer order API, and since 2023 its shipping emails carry
// less and less: often just a status line, the order number and a "Track
// package" button, no item names, no carrier number. So the email's SUBJECT
// is the tracking signal — "Shipped:", "Arriving today:", "Delivered:" — and
// this file turns one into the same shape a carrier poll would have returned.
// Zero clicks: a mail rule forwards the store's emails to the workspace's
// receipt address, and the parcel moves on its own.
//
// Heuristic-first, no AI. The vocabulary is small and stable (every store and
// carrier says shipped / out for delivery / delivered in a handful of ways),
// and a rule that reads the subject line is both cheaper and more accountable
// than a model deciding whether a parcel arrived.
//
// Pure: takes the email, returns what it says. Applying it is the route's job.

import { findTracking } from "ts-tracking-number";

export type ShipmentEmailState = "in_transit" | "out_for_delivery" | "delivered" | "exception";

export interface ShipmentEmail {
  kind: "shipment";
  state: ShipmentEmailState;
  /** The store, when the sender tells us (Amazon, or a Shopify store name);
   *  null for a carrier's own notification, which names no store. */
  vendor: string | null;
  orderRef: string | null;
  trackingNumber: string | null;
  /** One line for the record and the card: the subject, cleaned. */
  description: string;
  /** "today" / "tomorrow" when the email says so; the cadence's arrival-day
   *  rule wants a date, not a phrase. */
  expectedArrival: "today" | "tomorrow" | null;
  /** The promised day as a date, when the email names one. */
  expectedArrivalDate: string | null;
}

export interface OrderNotice {
  kind: "order";
  vendor: string | null;
  orderRef: string | null;
  expectedArrivalDate: string | null;
}

/** An order confirmation whose lines the parser could NOT read — Amazon's
 *  "Ordered: 1 Electronics item" is often a subject, a link and a footer.
 *  The order still has to exist: without it the shipping notices that follow
 *  have nothing to attach to, and a promised day the email carries is lost.
 *  This is the shape that opens the order as an awaiting session instead. */
export function classifyOrderNotice(email: EmailInput, now: Date = new Date()): OrderNotice | null {
  const subject = (email.subject ?? "").replace(/^(?:fwd?|fw|re):\s*/i, "").trim();
  if (!isOrderConfirmation(subject)) return null;
  const from = (email.from_email ?? "").toLowerCase();
  const body = email.text ?? "";
  const haystack = `${subject}\n${body}`;
  const orderRef = AMAZON_ORDER.exec(haystack)?.[1] ?? orderRefsInHtml(email.html ?? "")[0] ?? GENERIC_ORDER.exec(haystack)?.[1] ?? null;
  return {
    kind: "order",
    vendor: vendorOf(from, subject),
    orderRef,
    expectedArrivalDate: promisedDateIn(haystack, now) ?? promisedDateIn(stripTags(email.html ?? ""), now),
  };
}

/** Enough html-to-text for a date phrase: tags out, entities left alone. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

export interface ForwardingVerification {
  kind: "forwarding-verification";
  provider: "gmail" | "other";
}

export interface EmailInput {
  subject?: string | null;
  text?: string | null;
  /** The raw html, when there is one. Amazon's order number is reliably in a
   *  link (`orderID=114-…`) and often NOWHERE in the plain text, whose
   *  visible body is a legal footer. Stripping html to text loses the href. */
  html?: string | null;
  from_email?: string | null;
}

/** A sender that is a store's or carrier's MACHINE, not a person. What it
 *  sends that this file cannot read (a promotion, a survey, "free 90 days of
 *  music with your order") is not a receipt and must not become one. */
export function isAutomatedStoreSender(from: string | null | undefined): boolean {
  const f = (from ?? "").toLowerCase();
  const at = f.lastIndexOf("@");
  if (at < 0) return false;
  const host = f.slice(at + 1);
  return STORE_SENDER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** The stores and carriers whose machines write the emails this file reads.
 *  One list: the sender test above and the mailbox allowlist (a mail source
 *  asks Gmail only for mail from these, plus the stores a person adds) both
 *  read it, so a domain added here is read everywhere at once. */
export const STORE_SENDER_DOMAINS: readonly string[] = [
  "amazon.com",
  "amazon.ca",
  "amazon.co.uk",
  "amazon.de",
  "amazon.fr",
  "amazon.es",
  "amazon.it",
  "amazon.co.jp",
  "amazon.com.au",
  "amazon.in",
  "ups.com",
  "fedex.com",
  "usps.com",
  "dhl.com",
  "ontrac.com",
];

/** Order references in a link, where Amazon actually keeps them. */
function orderRefsInHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/order[-_]?i[dD]\s*=\s*(\d{3}-\d{7}-\d{7})/g)) out.push(m[1]!);
  for (const m of html.matchAll(/\b(\d{3}-\d{7}-\d{7})\b/g)) out.push(m[1]!);
  return out;
}

/** A mail provider asking "may this address receive your forwarded mail?".
 *
 *  The one email that would otherwise defeat the whole zero-click setup: Gmail
 *  sends its confirmation link TO the receipt address, so the person setting
 *  up the rule never sees it and the rule never activates. Recognised so the
 *  ingest can relay it to them instead of trying to parse it as a receipt. */
export function isForwardingVerification(email: EmailInput): ForwardingVerification | null {
  const from = (email.from_email ?? "").toLowerCase();
  const subj = (email.subject ?? "").toLowerCase();
  // Gmail's system sender is forwarding-noreply at google.com. Matched as two
  // halves: lint:instance-identity refuses an email-shaped literal in shipping
  // code, and rightly — but this is a third party's well-known address, not
  // one deployment's identity.
  const gmailSender = from.startsWith("forwarding-noreply@") && from.endsWith("google.com");
  if (gmailSender || /gmail forwarding confirmation/.test(subj)) {
    return { kind: "forwarding-verification", provider: "gmail" };
  }
  if (/forwarding confirmation|confirm(?:ation)?\b.*\bforward|verify.*forward/.test(subj)) {
    return { kind: "forwarding-verification", provider: "other" };
  }
  return null;
}

/** Amazon's order numbers are 3-7-7 digits; everything else is "Order #X". */
const AMAZON_ORDER = /\b(\d{3}-\d{7}-\d{7})\b/;
const GENERIC_ORDER = /\border\s*(?:#|no\.?|number|id)?[:\s]*#?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i;

/** Vendor from the sender, for the senders that ARE a store. A carrier's own
 *  notification (ups.com, fedex.com) names no store, so vendor stays null and
 *  the parcel is matched by its tracking number instead. */
function vendorOf(from: string, subject: string): string | null {
  if (/@(?:[a-z0-9-]+\.)?amazon\.(?:com|ca|co\.uk|de|fr|es|it|co\.jp|com\.au|in)$/.test(from)) return "Amazon";
  // Shopify-hosted stores mail from their own domain but the subject often
  // carries the store name: "A shipment from Bambu Lab is on the way".
  const m = /(?:shipment|order) from ([A-Z][\w&' .-]{1,40}?) (?:is|has|was)\b/.exec(subject);
  if (m) return m[1]!.trim();
  return null;
}

/** The state a subject line announces. Order matters: "Delivered" beats
 *  "shipped" (a delivered email often recaps that it shipped), and a failed
 *  attempt beats both. */
function stateOf(subject: string, body: string): ShipmentEmailState | null {
  const s = subject.toLowerCase();
  const b = body.toLowerCase().slice(0, 4000);
  const has = (re: RegExp) => re.test(s) || re.test(b);

  if (/delivery attempt|could not be delivered|couldn't be delivered|undeliverable|returned to sender|delivery (?:issue|problem|exception)|delayed/.test(s)) return "exception";
  if (/\bdelivered\b/.test(s)) return "delivered";
  if (/out for delivery|arriving today|delivering today|will be delivered today|on the (?:truck|vehicle) for delivery/.test(s)) return "out_for_delivery";
  if (/\b(?:shipped|has shipped|on its way|on the way|in transit|dispatched|sent|shipment)\b/.test(s)) return "in_transit";

  // The subject said nothing decisive; the first lines of the body may.
  if (has(/your (?:package|parcel|order) (?:was|has been) delivered/)) return "delivered";
  if (has(/out for delivery|arriving today/)) return "out_for_delivery";
  if (has(/your (?:package|parcel|order) (?:has )?shipped|is on its way/)) return "in_transit";
  return null;
}

/** Tracking numbers in the text, kept only where the match is a whole token.
 *  findTracking is greedy with Amazon's alphanumeric shape and reports
 *  substrings of OTHER carriers' numbers as Amazon ("A1012345678" inside a UPS
 *  1Z…); a real Amazon number is TBA + 12 digits, and a real anything is
 *  bounded by non-alphanumerics. */
export function trackingNumbersIn(text: string): Array<{ number: string; carrier: string }> {
  const out: Array<{ number: string; carrier: string }> = [];
  const seen = new Set<string>();
  for (const f of findTracking(text)) {
    const n = f.trackingNumber;
    if (seen.has(n)) continue;
    const bounded = new RegExp(`(?:^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9])`);
    if (!bounded.test(text)) continue;
    if (f.courier.code === "amazon" && !/^TB[A-Z]\d{12}$/.test(n)) continue;
    seen.add(n);
    out.push({ number: n, carrier: f.courier.code });
  }
  return out;
}

const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** "Arriving: Tuesday, September 23" → an ISO date. Amazon's order and
 *  shipping emails both carry this, and it is the promised day the cadence's
 *  arrival-day rule wants. The year is never stated: the nearest one that puts
 *  the date within a month of now (a December order arrives in January). */
export function promisedDateIn(text: string, now: Date = new Date()): string | null {
  const m = /(?:arriving|arrives|expected|estimated delivery|delivery estimate|get it)[:\s]+(?:by\s+)?(?:[a-z]+day,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})\b/i.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1]!.toLowerCase()];
  const day = Number(m[2]);
  if (!month || day < 1 || day > 31) return null;
  let year = now.getFullYear();
  const candidate = new Date(Date.UTC(year, month - 1, day));
  const drift = (candidate.getTime() - now.getTime()) / 86_400_000;
  if (drift < -60) year += 1;
  else if (drift > 300) year -= 1;
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Order confirmations are RECEIPTS, not shipment events: they carry the
 *  lines, and the receipt parser owns them. Said explicitly so a "Shipped:"
 *  that also lists items is not mistaken for one. */
export function isOrderConfirmation(subject: string): boolean {
  return /^ordered:|order confirmation|thank(?:s| you) for your (?:order|purchase)|your order (?:has been |was )?(?:placed|received|confirmed)|order receipt/i.test(subject);
}

/** Read a shipping notification. Null when the email is not one — an order
 *  confirmation, a receipt, a newsletter — so the caller falls through to
 *  the receipt parser exactly as before. */
export function classifyShipmentEmail(email: EmailInput): ShipmentEmail | null {
  const subject = (email.subject ?? "").replace(/^(?:fwd?|fw|re):\s*/i, "").trim();
  const body = email.text ?? "";
  const from = (email.from_email ?? "").toLowerCase();
  if (!subject && !body) return null;
  if (isOrderConfirmation(subject)) return null;

  const state = stateOf(subject, body);
  if (!state) return null;

  const haystack = `${subject}\n${body}`;
  const html = email.html ?? "";
  const orderRef =
    AMAZON_ORDER.exec(haystack)?.[1] ??
    orderRefsInHtml(html)[0] ??
    GENERIC_ORDER.exec(haystack)?.[1] ??
    null;
  const vendor = vendorOf(from, subject);
  // Prefer a real carrier's number over Amazon's own: a parcel Amazon hands to
  // UPS is tracked at UPS, and the TBA number is only the label Amazon printed.
  const numbers = trackingNumbersIn(haystack);
  const tracking = numbers.find((n) => n.carrier !== "amazon") ?? numbers[0] ?? null;

  const lower = `${subject} ${body.slice(0, 2000)}`.toLowerCase();
  const expectedArrival =
    state === "out_for_delivery" || /\b(?:arriving|arrives|expected|delivery) (?:today|by end of day)\b/.test(lower)
      ? "today"
      : /\b(?:arriving|arrives|expected|delivery) tomorrow\b/.test(lower)
        ? "tomorrow"
        : null;

  return {
    kind: "shipment",
    state,
    vendor,
    orderRef,
    trackingNumber: tracking?.number ?? null,
    description: subject.slice(0, 200) || `Parcel ${state.replace("_", " ")}`,
    expectedArrival,
    expectedArrivalDate: promisedDateIn(haystack) ?? promisedDateIn(stripTags(html)),
  };
}

export type ReturnStage = "requested" | "dropped_off" | "received" | "refunded" | "cancelled";

export interface ReturnEmail {
  kind: "return";
  stage: ReturnStage;
  vendor: string | null;
  orderRef: string | null;
  /** What is being returned, as the subject names it. */
  item: string | null;
  /** The money coming back, when the email says how much. */
  refundAmount: number | null;
  description: string;
}

/** A return, read as the reverse of a delivery: requested, dropped off,
 *  received, refunded. Amazon sends each as its own email from return@, and
 *  unrecognised they would parse as receipts for things being sent BACK. A
 *  return is money on its way; that is worth a card. */
export function classifyReturnEmail(email: EmailInput): ReturnEmail | null {
  const subject = (email.subject ?? "").replace(/^(?:fwd?|fw|re):\s*/i, "").trim();
  const from = (email.from_email ?? "").toLowerCase();
  const s = subject.toLowerCase();
  const body = email.text ?? "";
  const isReturnSender = from.startsWith("return@") || from.startsWith("returns@");
  if (!isReturnSender && !/\breturn\b|\brefund\b|\bcancel/.test(s)) return null;

  let stage: ReturnStage | null = null;
  // A cancellation is the reverse event that happens BEFORE anything ships:
  // "Item cancelled successfully: "…"". Same door, same card, and the order
  // stops being watched for an arrival that will never come.
  if (/\b(?:item|order)\s+cancell?ed|cancellation (?:confirmed|successful)|cancell?ed successfully/.test(s)) stage = "cancelled";
  if (/refund (?:issued|processed|sent|is on its way)|advance refund|your refund/.test(s)) stage = "refunded";
  else if (/dropoff confirmed|drop-off confirmed|dropped off|drop off confirmed/.test(s)) stage = "dropped_off";
  else if (/return (?:received|complete|processed)|we(?:'ve| have) received your return/.test(s)) stage = "received";
  else if (/return request confirmed|return (?:started|requested|initiated|authori[sz]ed)|return label/.test(s)) stage = "requested";
  if (!stage) return null;

  const item =
    /(?:confirmed|issued|received|started|label) for (.+?)(?:\.{3}|…|\s*$)/i.exec(subject)?.[1]?.trim() ??
    /cancell?ed[^:]*:\s*"(.+?)(?:\.{3}|…|")/i.exec(subject)?.[1]?.trim() ??
    null;
  const haystack = `${subject}\n${body}`;
  const orderRef = AMAZON_ORDER.exec(haystack)?.[1] ?? orderRefsInHtml(email.html ?? "")[0] ?? GENERIC_ORDER.exec(haystack)?.[1] ?? null;
  const money = /(?:refund(?:ed)?(?: of| amount)?|total)[^$€£\d]{0,40}([$€£])\s?(\d{1,6}(?:[.,]\d{2})?)/i.exec(haystack);
  const refundAmount = money ? Number(money[2]!.replace(",", ".")) : null;

  return {
    kind: "return",
    stage,
    vendor: vendorOf(from, subject),
    orderRef,
    item,
    refundAmount: Number.isFinite(refundAmount as number) ? refundAmount : null,
    description: subject.slice(0, 200),
  };
}

