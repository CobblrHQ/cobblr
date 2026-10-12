// A store's own page for an order line (#5719). The owner, on a Kingroon
// order of three 10 kg PETG packs: "What I would love is if it actually
// navigates to the product page and figures out the individual 10 filament
// spools that each line contains." A store that sells variants prints each
// line as "TITLE - option / option / option"; its public product data names
// every variant, each with its own photo, and the colours it is sold in.
//
// Pure: the email, the product data and the line in, the answer out. The
// fetching lives in core-scan (services/store-product.ts), behind the
// workspace's egress policy.

import { storeVariantOf } from "@cobblr/platform-contract/same-product";

/** A store's product, as its public product data gives it (Shopify's
 *  `/products/<handle>.js`, trimmed to what is read here). */
export interface StoreProduct {
  title: string;
  handle: string;
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{
    id?: number | string;
    title: string;
    option1?: string | null;
    option2?: string | null;
    option3?: string | null;
    price?: number | string | null;
    featured_image?: { src?: string | null } | null;
  }>;
}

export type StoreVariant = StoreProduct["variants"][number];

/** The original sender of a forwarded email: the "From:" under the forward
 *  marker a mail app writes. Null when the email is not a forward. */
export function forwardedSender(text: string | null | undefined): { name: string | null; email: string } | null {
  const t = text ?? "";
  const marker = t.search(/-{3,}\s*Forwarded message\s*-{3,}|Begin forwarded message:|-{3,}\s*Original Message\s*-{3,}/i);
  if (marker < 0) return null;
  const from = t.slice(marker).match(/^\s*\*?From:\*?\s*(.*)$/im)?.[1] ?? "";
  const email = from.match(/<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i)?.[1];
  if (!email) return null;
  const name = from.replace(/<[^>]*>/, "").replace(email, "").replace(/["']/g, "").trim() || null;
  return { name, email: email.toLowerCase() };
}

/** Senders that are a mail service, not the store: its address says nothing
 *  about where the store lives. */
const MAIL_SERVICE = /(^|\.)(shopifyemail\.com|shopify\.com|myshopify\.com|klaviyomail\.com|sendgrid\.net|mailchimp(app)?\.com|mcsv\.net|amazonses\.com|gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|yahoo\.com|icloud\.com|me\.com)$/i;

/** The store's web host from the address it wrote from: "hi@shop.example.com"
 *  is shop.example.com; a mail subdomain ("mail.", "e.", "news.") is dropped.
 *  Null for a mail service's address. */
export function storeHostOf(email: string | null | undefined): string | null {
  const domain = email?.split("@")[1]?.toLowerCase().trim();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || MAIL_SERVICE.test(domain)) return null;
  const parts = domain.split(".");
  const sub = /^(mail|email|e|em|news|newsletter|info|orders?|shop|store|notifications?|noreply|reply|m|t)$/;
  while (parts.length > 2 && sub.test(parts[0]!)) parts.shift();
  return parts.join(".");
}

/** Hosts in an email that are never the shop: carriers, social sites, the
 *  places a store links to without being them. */
const NOT_A_STORE = /(^|\.)(ups\.com|fedex\.com|usps\.com|dhl\.com|amazon\.com|aftership\.com|17track\.net|parcelsapp\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|pinterest\.com|google\.com|apple\.com|paypal\.com|cdn\.shopify\.com)$/i;

/** A sender that is never a shop: a carrier, a social site. Amazon is a
 *  shop when it is the sender, so only the body's links set it aside. */
export function isNotAStore(host: string | null | undefined): boolean {
  return !!host && NOT_A_STORE.test(host) && !/(^|\.)amazon\.com$/i.test(host);
}

/** The store's host from what its email SAYS, for an email whose sender is a
 *  mail service (a Shopify notice comes from t.shopifyemail.com): the store's
 *  own contact address first ("contact us at shop@kingroon.com"), then its
 *  links. Never a mail service, a carrier or a social site, and never the
 *  person's own domain (`notOf`). Null when the email names no store (#6004). */
export function storeHostInText(text: string | null | undefined, notOf?: string | null): string | null {
  // A mail header names people, never the shop: the forward's "To:" is the
  // person who forwarded it (#6004, read as example.org before this).
  const t = (text ?? "").replace(/^[ \t>*]*(to|cc|bcc|from|reply-to|sent|date|subject|delivered-to|return-path)\s*:.*$/gim, "");
  const own = storeHostOf(notOf ?? null);
  const pick = (hosts: Array<string | null>): string | null => {
    const counts = new Map<string, number>();
    for (const h of hosts) if (h && h !== own && !NOT_A_STORE.test(h)) counts.set(h, (counts.get(h) ?? 0) + 1);
    let best: string | null = null;
    for (const [h, n] of counts) if (!best || n > counts.get(best)!) best = h;
    return best;
  };
  const addressed = pick([...t.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,})/gi)].map((m) => storeHostOf(`x@${m[1]}`)));
  if (addressed) return addressed;
  return pick([...t.matchAll(/https?:\/\/([A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,})/gi)].map((m) => storeHostOf(`x@${m[1]}`)));
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function optionsOf(v: StoreVariant): string[] {
  return [v.option1, v.option2, v.option3].filter((o): o is string => typeof o === "string" && o !== "").map(norm);
}

/** The product an order line names, among a store's search answers: the one
 *  whose title is the line's title. */
export function sameTitle(product: Pick<StoreProduct, "title">, line: string): boolean {
  const v = storeVariantOf(line);
  return !!v && norm(product.title) === v.base;
}

/** The variant an order line bought: its options, in order, as printed. */
export function lineVariant(product: StoreProduct, line: string): StoreVariant | null {
  const v = storeVariantOf(line);
  if (!v || norm(product.title) !== v.base) return null;
  return product.variants.find((x) => optionsOf(x).join("/") === v.options.join("/")) ?? null;
}

/** Which option is the colour, by its name. */
export function colourOptionAt(product: StoreProduct): number {
  return product.options.findIndex((o) => /colou?r|shade|hue/i.test(o.name));
}

/** A colour value that is several colours: a mixed pack ("Multicolor",
 *  "Multicolor-1", "Mixed", "Assorted", "Rainbow"). */
export function isMixedColour(value: string | null | undefined): boolean {
  return /\b(multi[\s-]?colou?r|multicolou?r|mixed|assorted|rainbow|variety|combo|bundle)/i.test(value ?? "");
}

/** The single colours the product is sold in: every colour value that is
 *  not itself a mix, as the store names them. */
export function singleColours(product: StoreProduct): string[] {
  const at = colourOptionAt(product);
  if (at < 0) return [];
  return product.options[at]!.values.filter((c) => !isMixedColour(c));
}

/** The variant like `like` but in `colour` (the same warehouse and size):
 *  each spool of a mixed pack is named and pictured as the store sells it
 *  on its own. */
export function variantInColour(product: StoreProduct, like: StoreVariant, colour: string): StoreVariant | null {
  const at = colourOptionAt(product);
  if (at < 0) return null;
  const want = optionsOf(like);
  want[at] = norm(colour);
  return product.variants.find((x) => optionsOf(x).join("/") === want.join("/")) ?? null;
}

/** A variant's own photo, as a link. */
export function variantPhoto(v: StoreVariant | null | undefined): string | null {
  const src = v?.featured_image?.src ?? null;
  if (!src) return null;
  return src.startsWith("//") ? `https:${src}` : /^https?:\/\//i.test(src) ? src : null;
}

/** The least confidence a spool's colour is taken at. Below it the spool
 *  is kept, as a colour not read, never guessed. */
export const PACK_COLOUR_MIN_CONFIDENCE = 0.5;

/** A pack's colours from one read of its photo, one per item (#5719): a
 *  colour the store sells, read with confidence, or null for a spool the
 *  read could not name (a low confidence, a colour the store does not sell,
 *  or a spool the read missed). Extra answers past the pack's count are
 *  dropped. Null when no spool was named at all: then the pack stays
 *  together. */
export function packColoursRead(
  named: ReadonlyArray<{ label: string; confidence?: number | null }>,
  choices: readonly string[],
  count: number,
): Array<string | null> | null {
  const byNorm = new Map(choices.map((c) => [norm(c), c]));
  const out: Array<string | null> = [];
  for (let i = 0; i < count; i++) {
    const n = named[i];
    const sure = n && (n.confidence == null || n.confidence >= PACK_COLOUR_MIN_CONFIDENCE);
    out.push(sure ? (byNorm.get(norm(n!.label)) ?? null) : null);
  }
  return out.some((c) => c !== null) ? out : null;
}

/** What the card says about a pack the store's page could not take apart:
 *  it stays N together, never "+1", and says why on hover. */
export function packPartsNote(meta: unknown): { sentence: string; why: string } | null {
  const m = (meta ?? {}) as { pack_parts?: { status?: unknown; why?: unknown }; line_pack?: { count?: unknown } };
  if (m.pack_parts?.status !== "unread") return null;
  const n = typeof m.line_pack?.count === "number" ? m.line_pack.count : null;
  return {
    sentence: n ? `Which colours the ${n} are could not be read, so they stay together.` : "Which colours the pack holds could not be read.",
    why: typeof m.pack_parts.why === "string" ? m.pack_parts.why : "",
  };
}
