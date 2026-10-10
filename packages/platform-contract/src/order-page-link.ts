// A store's order email carries a button to the order's own page ("View
// order", "Order status"). On a Shopify store that link signs the buyer in by
// itself, and the page lists each line with its own carrier and tracking
// number (#5461). The link is a sign-in credential: it is found here, handed
// straight to Purchases to be encrypted, and never shown, logged or sent on.

export interface OrderPageLink {
  url: string;
  /** The store's own host, the only part ever shown. */
  host: string;
}

const BUTTON_WORDS = /\b(view (your )?order( status)?|(your )?order status|check (your )?order|track (your )?order|manage (your )?order)\b/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function textOf(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Whether the email came from a Shopify store: its markup or its sending domain says so. */
export function isShopifyOrderEmail(html: string, fromEmail?: string | null): boolean {
  if (fromEmail && /@([a-z0-9-]+\.)*shopifyemail\.com$/i.test(fromEmail.trim())) return true;
  return /cdn\.shopify\.com|shopifyemail\.com|\/account\/orders\/|\/_t\/c\/|\/orders\/[0-9a-f]{32}\/authenticate/i.test(html);
}

/** The order page's link in a Shopify store's order email, or null. Only an
 *  https link whose button reads like the order's own page. */
export function findOrderPageLink(html: string | null | undefined, fromEmail?: string | null): OrderPageLink | null {
  if (!html || !isShopifyOrderEmail(html, fromEmail)) return null;
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = anchor.exec(html); m; m = anchor.exec(html)) {
    const words = textOf(m[3] ?? "");
    if (!BUTTON_WORDS.test(words)) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities((m[2] ?? "").trim()));
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    return { url: url.href, host: url.hostname.replace(/^www\./, "") };
  }
  return null;
}

/** Remove a sign-in link from any text before it is stored, logged or shown:
 *  each occurrence becomes the store's host. */
export function withoutOrderPageLink(text: string, link: OrderPageLink | string): string {
  const url = typeof link === "string" ? link : link.url;
  if (!url) return text;
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = "the store";
  }
  return text.split(url).join(`[${host} order page]`);
}

const SIGN_IN_URL = /https?:\/\/[^\s"'<>()]*(?:\/_t\/c\/|\/authenticate\?key=|\/account\/orders\/[0-9a-f]{32})[^\s"'<>()]*/gi;

/** An email's text or html with every store sign-in link taken out: the one
 *  found, and anything shaped like one (a click-tracking link, an order
 *  status key). What is left goes on to be filed, parsed and maybe read by a
 *  model, so nothing that signs in may survive in it. */
export function withoutSignInLinks(text: string, found?: OrderPageLink | null): string {
  const once = found ? withoutOrderPageLink(text, found) : text;
  return once.replace(SIGN_IN_URL, (url) => {
    try {
      return `[${new URL(url.replace(/&amp;/g, "&")).hostname.replace(/^www\./, "")} order page]`;
    } catch {
      return "[order page]";
    }
  });
}

/** Whether text holds anything shaped like a store sign-in link. */
export function hasSignInLink(text: string): boolean {
  SIGN_IN_URL.lastIndex = 0;
  const found = SIGN_IN_URL.test(text);
  SIGN_IN_URL.lastIndex = 0;
  return found;
}

/** The order page's link in plain text: an email's plain part writes the
 *  "View order" button as its bare URL. The first https sign-in link, or null. */
export function orderPageLinkInText(text: string): OrderPageLink | null {
  for (const m of text.matchAll(SIGN_IN_URL)) {
    try {
      const url = new URL(m[0].replace(/&amp;/g, "&").replace(/[.,;:!?\]]+$/, ""));
      if (url.protocol !== "https:") continue;
      return { url: url.href, host: url.hostname.replace(/^www\./, "") };
    } catch {
      continue;
    }
  }
  return null;
}

/** What a store's order page says about its order, with no link in it: the
 *  order's own name ("#36772"), each line in the store's words with its
 *  quantity, and the parcels so far. Purchases reads it; the email ingest and
 *  the scan inbox fill a receipt session from it with no model asked. A
 *  redacted read (the guest view a worn link falls back to) still carries the
 *  name and the lines; only tracking numbers go. */
export interface OrderPageSummary {
  store: string;
  order_name: string | null;
  /** "read" | "redacted" | "expired" | "throttled" | "unsupported" | "failed" | "off" */
  outcome: string;
  lines: Array<{ name: string; qty: number; unit_price: number | null; currency: string | null }>;
  parcels: Array<{ tracking_number: string | null; carrier: string | null; state: string; lines: Array<{ name: string; qty: number }> }>;
  /** Where the last read went, hop by hop (status, host, path words), with
   *  every token cut: why a read that missed missed. */
  trail?: string[];
}

/** The lines a summary can fill a receipt with: the order's own, else every
 *  parcel's, merged by name. Empty when the page gave neither. */
export function orderPageLines(s: OrderPageSummary): OrderPageSummary["lines"] {
  if (s.lines.length) return s.lines;
  const byName = new Map<string, OrderPageSummary["lines"][number]>();
  for (const p of s.parcels) {
    for (const l of p.lines) {
      const had = byName.get(l.name);
      byName.set(l.name, had ? { ...had, qty: had.qty + l.qty } : { name: l.name, qty: l.qty, unit_price: null, currency: null });
    }
  }
  return [...byName.values()];
}
