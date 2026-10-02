// The pictures a person was SHOWN, kept a while, so the one they choose is the
// one stored (#4580).
//
// A web search result was drawn straight from its site in the browser; Use
// this image then asked the site again from the server, and a site that
// blocks hotlinking (or a home address a search engine has walled) said no:
// "That image couldn't be used". The person was looking at it full size. "It's
// already big, we already have it, just use it."
//
// So a result is shown through Cobblr's own proxy (GET /image-proxy),
// which fetches it once and keeps the bytes here for half an hour, per
// workspace, within a size cap. Use it, AI Pick and a tapped tile store from
// here (downloadCatalogImage), so a picture the person can see is never asked
// for twice. Only a picture that is not here is fetched.
//
// In memory, per api process: a pick lands on the process that showed the
// picture almost always, and when it does not the fetch is the fallback it
// always was.

import { sniffType } from "@cobblr/platform-contract/sniff-type";
import { browserImageHeaders } from "./image-fetch-headers.js";

export const SHOWN_TTL_MS = 30 * 60_000;
/** One picture larger than this is not kept (nor stored: the catalog's cap). */
export const SHOWN_MAX_BYTES = 10 * 1024 * 1024;
/** What one workspace may hold at once; the oldest goes first. */
export const SHOWN_ORG_BUDGET_BYTES = 64 * 1024 * 1024;

export interface ShownImage {
  bytes: Uint8Array;
  mime: string;
  at: number;
}

const byOrg = new Map<string, Map<string, ShownImage>>();

function sweep(orgId: string, now: number): Map<string, ShownImage> {
  let m = byOrg.get(orgId);
  if (!m) {
    m = new Map();
    byOrg.set(orgId, m);
  }
  for (const [k, v] of m) if (now - v.at > SHOWN_TTL_MS) m.delete(k);
  return m;
}

/** Keep what was shown. The oldest pictures make room for a new one. */
export function rememberShown(orgId: string, url: string, img: { bytes: Uint8Array; mime: string }, now = Date.now()): void {
  if (img.bytes.byteLength === 0 || img.bytes.byteLength > SHOWN_MAX_BYTES) return;
  const m = sweep(orgId, now);
  m.delete(url);
  m.set(url, { bytes: img.bytes, mime: img.mime, at: now });
  let total = 0;
  for (const v of m.values()) total += v.bytes.byteLength;
  for (const [k, v] of m) {
    if (total <= SHOWN_ORG_BUDGET_BYTES) break;
    m.delete(k);
    total -= v.bytes.byteLength;
  }
}

/** The bytes the person was shown at this address, while they are kept. */
export function shownImage(orgId: string, url: string, now = Date.now()): ShownImage | null {
  const v = sweep(orgId, now).get(url);
  return v ?? null;
}

export type ImageFetch = (url: string, init: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** Fetch a picture to SHOW it, and keep it. Null when the site will not give
 *  it or it is not a picture. `page` is the result page it was found on, for
 *  the sites that only serve their images to their own pages. */
export async function fetchShownImage(orgId: string, url: string, fetcher: ImageFetch, page?: string | null): Promise<ShownImage | null> {
  const kept = shownImage(orgId, url);
  if (kept) return kept;
  const headers = browserImageHeaders(url);
  if (page) headers.referer = page;
  const res = await fetcher(url, { headers, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!res || !res.ok) return null;
  if (Number(res.headers.get("content-length") ?? 0) > SHOWN_MAX_BYTES) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > SHOWN_MAX_BYTES) return null;
  // What the bytes say, never what the site claims: a page of HTML is not a
  // picture however it is labelled.
  const mime = sniffType(bytes.subarray(0, 64));
  if (!mime || !mime.startsWith("image/") || mime === "image/svg+xml") return null;
  rememberShown(orgId, url, { bytes, mime });
  return { bytes, mime, at: Date.now() };
}
