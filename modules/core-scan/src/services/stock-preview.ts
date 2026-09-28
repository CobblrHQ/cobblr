// A stock agency's watermarked preview is never a picture we use (#3804).
//
// One question with two shapes: an address alone (the download gate, the
// network gate, a provider's picture), and a search result, which also has
// the page it was found on and that page's title. The agencies are data in
// stock-picture-sources.ts.

import { STOCK_AGENCY_HOSTS, STOCK_PREVIEW_FILENAME_MARKERS, STOCK_TITLE_PHRASES } from "./stock-picture-sources.js";

function onAgencyHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return STOCK_AGENCY_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    // A result's `source` is a bare host.
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim()) ? value.trim() : null;
  }
}

/** The picture at this address is an agency's preview: its host is an
 *  agency's, or its file name carries a marker only a preview has. */
export function isStockPreviewUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(String(url).trim());
  } catch {
    return false;
  }
  if (onAgencyHost(u.hostname)) return true;
  const file = decodeURIComponent(u.pathname.split("/").pop() ?? "").toLowerCase();
  return STOCK_PREVIEW_FILENAME_MARKERS.some((m) => file.includes(m));
}

const TITLE_RE = new RegExp(
  `(^|[^a-z0-9])(${STOCK_TITLE_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})([^a-z0-9]|$)`,
  "i",
);

/** A search result that is an agency's preview: the picture's address, the
 *  page it was found on, or the page's own title says so. */
export function isStockPreviewResult(r: { url?: string | null; source?: string | null; title?: string | null }): boolean {
  if (isStockPreviewUrl(r.url)) return true;
  const page = r.source ? hostOf(r.source) : null;
  if (page && onAgencyHost(page)) return true;
  return !!r.title && TITLE_RE.test(r.title);
}
