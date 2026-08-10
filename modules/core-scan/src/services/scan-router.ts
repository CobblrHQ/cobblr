// Scan-code routing. A scanned code isn't always a product barcode — it can be
// an Amazon ASIN/FNSKU, an ISBN, or a URL. Each belongs at a different resolver,
// and routing by TYPE up front stops non-barcodes from wasting the UPC chain
// (go-upc's crawl-delay gate + upcitemdb's daily budget) — which, when the budget
// is throttled, falsely marks them "rate-limited" and loops forever.
//
// classifyScanCode is a pure function (unit-tested). resolveIsbn / resolveAsin are
// the type-specific lookups enrich dispatches to.

import type { BarcodeHit } from "./barcode-lookup.js";

export type ScanCodeType = "upc" | "isbn" | "asin" | "fnsku" | "url" | "unknown";

/** Classify a scanned string by what kind of code it is. */
export function classifyScanCode(raw: string): { type: ScanCodeType; code: string } {
  const code = (raw ?? "").trim();
  if (!code) return { type: "unknown", code };

  // A URL (QR codes — maker pages, etc.).
  if (/^https?:\/\//i.test(code)) return { type: "url", code };

  // Numeric barcodes: UPC-A/E, EAN-8/13, GTIN-14 — and ISBN-13 (a 978/979 EAN).
  if (/^[0-9]{6,14}$/.test(code)) {
    if (/^(978|979)[0-9]{10}$/.test(code)) return { type: "isbn", code }; // ISBN-13
    return { type: "upc", code };
  }

  // Amazon FNSKU: a warehouse/fulfillment label (X00 + 7 alnum). Maps to a product
  // ONLY inside Amazon's system — no public database can ever resolve it.
  if (/^X00[A-Z0-9]{7}$/i.test(code)) return { type: "fnsku", code: code.toUpperCase() };

  // ISBN-10: 9 digits + a check char (0-9 or X). (Pure 10-digit numerics already
  // classified as "upc" above; go-upc handles those books fine.)
  if (/^[0-9]{9}[0-9X]$/i.test(code)) return { type: "isbn", code: code.toUpperCase() };

  // Amazon ASIN: 10 chars starting with B. The rule USED to be "10 alphanumerics
  // containing a letter", which is also the shape of every manufacturer serial
  // and asset tag on the planet: an HP monitor's `CNT034F0XH` classified as an
  // Amazon product, so it skipped the non-product guard and a web search for the
  // bare serial named the item after an unrelated gas detector whose part number
  // merely ended in the same `0XH` (2026-08-10). Non-book ASINs are B-prefixed;
  // book ASINs are ISBN-10s, already classified above. A serial that genuinely
  // starts with B still misses here, which is why the hold rule no longer trusts
  // classification alone.
  if (/^B[A-Z0-9]{9}$/i.test(code)) return { type: "asin", code: code.toUpperCase() };

  return { type: "unknown", code };
}

/** A book by ISBN, via Open Library (free, no key). null on miss/unreachable. */
export async function resolveIsbn(isbn: string): Promise<BarcodeHit | null> {
  const clean = isbn.replace(/[^0-9X]/gi, "").toUpperCase();
  if (!clean) return null;
  const res = await fetch(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${clean}&format=json&jscmd=data`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const j = (await res.json().catch(() => ({}))) as Record<string, OpenLibraryBook>;
  const b = j[`ISBN:${clean}`];
  if (!b || !b.title) return null;
  const authors = (b.authors ?? []).map((a) => a.name).filter(Boolean).join(", ");
  return {
    source: "openlibrary",
    title: authors ? `${b.title} — ${authors}` : b.title,
    brand: b.publishers?.[0]?.name ?? authors ?? null,
    model: clean,
    description: b.subtitle ?? null,
    category: "Books",
    image_url: b.cover?.medium ?? b.cover?.large ?? b.cover?.small ?? null,
    raw: { openlibrary: { key: b.key, url: b.url, authors, isbn: clean } },
  };
}

interface OpenLibraryBook {
  title: string;
  subtitle?: string;
  key?: string;
  url?: string;
  authors?: { name: string }[];
  publishers?: { name: string }[];
  cover?: { small?: string; medium?: string; large?: string };
}

/** Best-effort product name for an Amazon ASIN by reading its product page title.
 *  Amazon aggressively blocks automation, so this often fails — on any failure we
 *  return null and let enrich's web-search fallback (which finds the listing via
 *  search) take over. */
export async function resolveAsin(asin: string): Promise<BarcodeHit | null> {
  const a = asin.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(a)) return null;
  const res = await fetch(`https://www.amazon.com/dp/${a}`, {
    headers: {
      // A real browser UA — datacenter UAs get an instant block page.
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      accept: "text/html",
    },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const html = await res.text().catch(() => "");
  // The product title is in #productTitle, or the <title> ("… : Amazon.com").
  let title =
    /<span[^>]*id="productTitle"[^>]*>([^<]+)<\/span>/i.exec(html)?.[1]?.trim() ??
    /<title>([^<]+)<\/title>/i.exec(html)?.[1]?.trim() ??
    "";
  title = title.replace(/\s*[:|-]\s*Amazon\.com.*$/i, "").replace(/^Amazon\.com\s*[:|-]\s*/i, "").trim();
  // A block/captcha page has no real title (or "Sorry! Something went wrong").
  if (!title || /robot|captcha|something went wrong|sorry/i.test(title) || title.length < 4) return null;
  const img = /<img[^>]+id="landingImage"[^>]+src="([^"]+)"/i.exec(html)?.[1] ?? null;
  return {
    source: "amazon",
    title: title.slice(0, 300),
    brand: null,
    model: a,
    description: null,
    category: null,
    image_url: img,
    raw: { amazon: { asin: a, url: `https://www.amazon.com/dp/${a}` } },
  };
}
