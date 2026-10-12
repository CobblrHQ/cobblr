// An order line's product, read on its store's public page (#5719): the
// variant it bought, with its own photo, and the colours the store sells.
// Shopify's public product data (`/search/suggest.json`, then
// `/products/<handle>.js`) answers with no sign-in and no model; a store
// that is not one answers nothing, and the line says so. Every request goes
// through the workspace's egress policy.

import { platform } from "@cobblr/platform-contract";
import { catalogRecording } from "./catalog-replay.js";
import { readWebCassette, replayingWeb, writeWebCassette } from "./web-replay.js";
import { storeVariantOf } from "@cobblr/platform-contract/same-product";
import { forwardedSender, isNotAStore, lineVariant, sameTitle, storeHostInText, storeHostOf, type StoreProduct, type StoreVariant } from "@cobblr/platform-contract/store-product";

export type StoreFetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type StoreRead =
  | { product: StoreProduct; variant: StoreVariant; url: string }
  | { unread: string };

const UA = "Mozilla/5.0 (compatible; Cobblr/1.0; order line lookup)";
const MAX_HANDLES = 3;
const CACHE_MS = 30 * 60_000;
const cache = new Map<string, { at: number; product: StoreProduct | null; why: string | null }>();

const live = (orgId: string): StoreFetch => (url) =>
  platform().egress.guardedFetch(orgId, url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });

/** A store's public data through the web door's cassettes (web-replay.ts):
 *  under replay a recorded answer, or a 404 when none was recorded, and the
 *  network never; under recording the live answer, written down. A test of
 *  a store read is the same every run (#6004). */
const guarded = (orgId: string): StoreFetch => async (url) => {
  if (replayingWeb()) {
    const c = readWebCassette<{ status: number; body: unknown }>("store", url);
    return c ? { ok: c.status >= 200 && c.status < 300, status: c.status, json: async () => c.body } : { ok: false, status: 404, json: async () => null };
  }
  const r = await live(orgId)(url);
  if (!catalogRecording()) return r;
  const body = await r.json().catch(() => null);
  writeWebCassette("store", url, { status: r.status, body });
  return { ok: r.ok, status: r.status, json: async () => body };
};

/** The store a receipt came from: a forward's original sender, else the
 *  address it came from. Null when neither names a store's own domain. */
export async function storeHostForReceipt(orgId: string, fileId: string | null, from: string | null): Promise<string | null> {
  let text: string | null = null;
  if (fileId) {
    const file = await platform().files.read(orgId, fileId, "original").catch(() => null);
    if (file && (/^text\//.test(file.mimeType) || file.mimeType === "")) text = new TextDecoder().decode(file.bytes.slice(0, 200_000));
  }
  return storeHostOfEmail(text, from);
}

/** The store an email came from: a forward's original sender, else its own
 *  sender; and when that is a mail service (a Shopify notice), the store its
 *  body names. A forwarded Kingroon order named no store, so its packs were
 *  never read or split (#6004). */
export function storeHostOfEmail(text: string | null, from: string | null): string | null {
  const sender = forwardedSender(text);
  const direct = storeHostOf(sender?.email ?? from);
  // A carrier's own notice (UPS, Amazon Logistics) is not from a shop.
  if (isNotAStore(direct)) return null;
  return direct ?? storeHostInText(text, from);
}

/** The product and variant an order line bought, from the store's page. */
export async function readStoreProduct(o: { orgId: string; host: string; line: string; fetch?: StoreFetch }): Promise<StoreRead> {
  const v = storeVariantOf(o.line);
  if (!v) return { unread: "the line names no variant" };
  const get = o.fetch ?? guarded(o.orgId);
  const key = `${o.host}|${v.base}`;
  const hit = cache.get(key);
  let product: StoreProduct | null;
  if (hit && Date.now() - hit.at < CACHE_MS) {
    if (!hit.product) return { unread: hit.why ?? "the store's page could not be read" };
    product = hit.product;
  } else {
    const found = await findProduct(get, o.host, v.base, o.line);
    cache.set(key, { at: Date.now(), product: "product" in found ? found.product : null, why: "unread" in found ? found.unread : null });
    if ("unread" in found) return found;
    product = found.product;
  }
  const variant = lineVariant(product, o.line);
  if (!variant) return { unread: "the store's page does not sell this variant" };
  return { product, variant, url: `https://${o.host}/products/${product.handle}` };
}

async function findProduct(get: StoreFetch, host: string, title: string, line: string): Promise<{ product: StoreProduct } | { unread: string }> {
  const q = encodeURIComponent(title);
  let search: Response | { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    search = await get(`https://${host}/search/suggest.json?q=${q}&resources%5Btype%5D=product&resources%5Blimit%5D=5`);
  } catch (e) {
    return { unread: `the store's page could not be reached (${(e as Error).message.slice(0, 80)})` };
  }
  if (!search.ok) return { unread: search.status === 401 || search.status === 403 ? "the store's page asks for a sign-in" : `the store's page answered ${search.status}` };
  const body = (await search.json().catch(() => null)) as { resources?: { results?: { products?: Array<{ handle?: string; title?: string }> } } } | null;
  const handles = (body?.resources?.results?.products ?? [])
    .filter((p) => typeof p.handle === "string" && /^[a-z0-9-]+$/i.test(p.handle))
    .sort((a, b) => Number(sameTitle({ title: b.title ?? "" }, line)) - Number(sameTitle({ title: a.title ?? "" }, line)))
    .slice(0, MAX_HANDLES)
    .map((p) => p.handle!);
  if (handles.length === 0) return { unread: body ? "the store's search does not list this product" : "the store's site is not one whose products can be read" };
  for (const handle of handles) {
    const r = await get(`https://${host}/products/${handle}.js`).catch(() => null);
    if (!r?.ok) continue;
    const p = (await r.json().catch(() => null)) as StoreProduct | null;
    if (p && Array.isArray(p.variants) && Array.isArray(p.options) && sameTitle(p, line)) return { product: p };
  }
  return { unread: "the store's page does not list this product" };
}

/** For tests: forget what was read. */
export function forgetStoreProducts(): void {
  cache.clear();
}
