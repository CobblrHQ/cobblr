// Scan-code routing. A scanned code isn't always a product barcode — it can be
// an Amazon ASIN/FNSKU, an ISBN, or a URL. Each belongs at a different resolver,
// and routing by TYPE up front stops non-barcodes from wasting the UPC chain
// (go-upc's crawl-delay gate + upcitemdb's daily budget) — which, when the budget
// is throttled, falsely marks them "rate-limited" and loops forever.
//
// classifyScanCode is a pure function (unit-tested). resolveIsbn / resolveAsin are
// the type-specific lookups enrich dispatches to.

import { gtinChecksumOk, hasStoreCodePrefix, isStoreCode, type BarcodeHit } from "./barcode-lookup.js";
import { hitCassette, replayMiss, writeCatalogCassette } from "./catalog-replay.js";

export type ScanCodeType = "upc" | "isbn" | "asin" | "fnsku" | "url" | "store-code" | "unknown";

/** Classify a scanned string by what kind of code it is. */
export function classifyScanCode(raw: string): { type: ScanCodeType; code: string } {
  const code = (raw ?? "").trim();
  if (!code) return { type: "unknown", code };

  // A URL (QR codes — maker pages, etc.).
  if (/^https?:\/\//i.test(code)) return { type: "url", code };

  // Numeric barcodes: UPC-A/E, EAN-8/13, GTIN-14 — and ISBN-13 (a 978/979 EAN).
  if (/^[0-9]{6,14}$/.test(code)) {
    if (/^(978|979)[0-9]{10}$/.test(code)) return { type: "isbn", code }; // ISBN-13
    // A shop's own label (GS1 restricted circulation): nothing outside that
    // shop can resolve it, so it never enters the product chain. The same
    // prefix with a BAD check digit is a mis-read of something, not a store
    // code and not a product: unknown.
    if (isStoreCode(code)) return { type: "store-code", code };
    if (hasStoreCodePrefix(code) && !gtinChecksumOk(code)) return { type: "unknown", code };
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

/** The decoder id an ISBN's fields decode under: a bundle field declaring
 *  `identifier:isbn` HOLDS the ISBN, one declaring `decode:author` / `decode:year`
 *  receives those keys. */
export const ISBN_DECODER_ID = "isbn";

/** The semantic bag for a book, from an Open Library record. Pure. The title
 *  is the BOOK'S title: the author used to be folded into it and the publisher
 *  prefixed as a brand, which is how a scan named "Mariner Books The Hobbit:
 *  or, There and Back Again" while Author, Year and ISBN sat blank beneath it
 *  (2026-09-12). Year is the four digits of `publish_date`, in any of the
 *  shapes the API uses ("2012", "September 18, 2012", "Sept 2012"). */
export function isbnFieldsFromOpenLibrary(
  b: OpenLibraryBook,
  isbn: string,
): Record<string, string | number> {
  const out: Record<string, string | number> = { isbn };
  if (b.title?.trim()) out.title = b.title.trim();
  const authors = (b.authors ?? []).map((a) => a.name?.trim()).filter(Boolean).join(", ");
  if (authors) out.author = authors;
  const year = /\b(1[5-9]\d{2}|20\d{2})\b/.exec(b.publish_date ?? "")?.[1];
  if (year) out.year = Number(year);
  const publisher = b.publishers?.[0]?.name?.trim();
  if (publisher) out.publisher = publisher;
  return out;
}

/** The book catalog could not be asked: the network, a non-2xx answer, a body
 *  that is not the API's. Distinct from "no such book" (a reachable catalog
 *  with no entry, which resolveIsbn answers with null): a caller that caches
 *  a miss, or stamps a cached answer as checked, must do neither on this.
 *  Open Library's Books API answered 404 to every ISBN for a stretch on
 *  2026-09-17; read as "no such book" that would have stamped every cached
 *  stray (#3162) as checked for a day and cached every fresh ISBN as a miss. */
export class BookDoorUnavailable extends Error {
  constructor(why: string) {
    super(`the book catalog could not be asked: ${why}`);
    this.name = "BookDoorUnavailable";
  }
}

/** A book by ISBN, via Open Library (free, no key). null when the catalog
 *  has no such book; throws BookDoorUnavailable when it could not be asked.
 *  The hit's title is the book's title and its brand the publisher; the
 *  structured bag rides in `fields` for the role-fill. */
export async function resolveIsbn(isbn: string): Promise<BarcodeHit | null> {
  const clean = isbn.replace(/[^0-9X]/gi, "").toUpperCase();
  if (!clean) return null;
  // A replay dir answers from its cassette and never from the network
  // (catalog-replay.ts); a recording session asks live and writes one. A
  // cassette saying rate_limited is the recorded shape of "could not be
  // asked", so a test can hold what an outage does.
  const replayed = replayMiss(clean, "book");
  if (replayed) {
    if (replayed.outcome === "rate_limited") throw new BookDoorUnavailable("recorded as unreachable");
    return replayed.outcome === "hit" ? replayed.hit : null;
  }
  // An outage is not recorded: the next recording session asks again.
  const live = await resolveIsbnLive(clean);
  writeCatalogCassette(clean, hitCassette(live), "book");
  return live;
}

const OPEN_LIBRARY_TIMEOUT_MS = 8000;

async function openLibraryJson<T>(url: string): Promise<{ ok: true; body: T } | { ok: false; why: string }> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(OPEN_LIBRARY_TIMEOUT_MS) }).catch(
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
  if ("error" in res) return { ok: false, why: res.error };
  if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
  const body = (await res.json().catch(() => undefined)) as T | undefined;
  if (body === undefined) return { ok: false, why: "not JSON" };
  return { ok: true, body };
}

/** Two doors on the one catalog. The Books API answers one call with the
 *  whole bag; when it cannot be asked, the edition record (`/isbn/<isbn>.json`)
 *  carries the same title, date and publisher and names its authors by key,
 *  read one more call each. A catalog reached through either door and
 *  holding no entry is a null; neither door reachable is BookDoorUnavailable. */
async function resolveIsbnLive(clean: string): Promise<BarcodeHit | null> {
  const books = await openLibraryJson<Record<string, OpenLibraryBook>>(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${clean}&format=json&jscmd=data`,
  );
  if (books.ok) {
    const b = books.body[`ISBN:${clean}`];
    return b?.title ? bookHit(b, clean) : null;
  }
  const edition = await openLibraryJson<OpenLibraryEdition>(`https://openlibrary.org/isbn/${clean}.json`);
  if (!edition.ok) {
    // A 404 here can be an ISBN the catalog does not hold, but with the Books
    // door already down there is no second opinion, so it reads as
    // unreachable: the safe direction, since nothing is cached or stamped on it.
    throw new BookDoorUnavailable(`books door: ${books.why}; edition door: ${edition.why}`);
  }
  const e = edition.body;
  if (!e?.title) return null;
  const authors: { name: string }[] = [];
  for (const a of (e.authors ?? []).slice(0, 4)) {
    const author = await openLibraryJson<{ name?: string }>(`https://openlibrary.org${a.key}.json`);
    if (author.ok && author.body?.name) authors.push({ name: author.body.name });
  }
  const cover = e.covers?.[0];
  return bookHit(
    {
      title: e.title,
      subtitle: e.subtitle,
      key: e.key,
      url: e.key ? `https://openlibrary.org${e.key}` : undefined,
      authors,
      publishers: (e.publishers ?? []).map((name) => ({ name })),
      publish_date: e.publish_date,
      cover: cover ? { medium: `https://covers.openlibrary.org/b/id/${cover}-M.jpg` } : undefined,
    },
    clean,
  );
}

function bookHit(b: OpenLibraryBook, clean: string): BarcodeHit {
  const fields = isbnFieldsFromOpenLibrary(b, clean);
  const authors = typeof fields.author === "string" ? fields.author : "";
  return {
    source: "openlibrary",
    title: b.title,
    brand: b.publishers?.[0]?.name ?? null,
    model: clean,
    description: b.subtitle ?? null,
    category: "Books",
    image_url: b.cover?.medium ?? b.cover?.large ?? b.cover?.small ?? null,
    raw: { openlibrary: { key: b.key, url: b.url, authors, isbn: clean, publish_date: b.publish_date ?? null } },
    fields,
    decoder_id: ISBN_DECODER_ID,
  };
}

/** The decoded bag for an ISBN hit that came from a tier that does not carry
 *  one (the shared resolver's Open Library mirror returns the composed title
 *  only): re-read the book from Open Library for its fields; on a miss, the
 *  hit's own title and the ISBN are still a bag worth landing. */
export async function isbnFieldsForHit(isbn: string, hit: BarcodeHit): Promise<Record<string, string | number>> {
  if (hit.fields) return hit.fields;
  const live = await resolveIsbn(isbn).catch(() => null);
  if (live?.fields) return live.fields;
  const out: Record<string, string | number> = { isbn: isbn.replace(/[^0-9X]/gi, "").toUpperCase() };
  // The mirror composes "Title — Author": split it back rather than land the
  // author in the title field.
  const [title, author] = hit.title.split(/\s+—\s+/, 2);
  if (title?.trim()) out.title = title.trim();
  if (author?.trim()) out.author = author.trim();
  return out;
}

export interface OpenLibraryBook {
  title: string;
  subtitle?: string;
  key?: string;
  url?: string;
  authors?: { name: string }[];
  publishers?: { name: string }[];
  publish_date?: string;
  cover?: { small?: string; medium?: string; large?: string };
}

/** The edition record behind `/isbn/<isbn>.json`: the same facts as the Books
 *  API's entry with authors as keys and covers as ids. */
interface OpenLibraryEdition {
  title?: string;
  subtitle?: string;
  key?: string;
  authors?: { key: string }[];
  publishers?: string[];
  publish_date?: string;
  covers?: number[];
}

/** Best-effort product name for an Amazon ASIN by reading its product page title.
 *  Amazon aggressively blocks automation, so this often fails — on any failure we
 *  return null and let enrich's web-search fallback (which finds the listing via
 *  search) take over. */
export async function resolveAsin(asin: string): Promise<BarcodeHit | null> {
  const a = asin.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(a)) return null;
  const replayed = replayMiss(a);
  if (replayed) return replayed.outcome === "hit" ? replayed.hit : null;
  const live = await resolveAsinLive(a);
  writeCatalogCassette(a, hitCassette(live));
  return live;
}

async function resolveAsinLive(a: string): Promise<BarcodeHit | null> {
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
