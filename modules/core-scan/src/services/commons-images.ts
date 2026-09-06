// A second place to get a picture from: the Wikimedia Commons photo library.
//
// The image engine (ddg-images.ts) is a scraped search page, and it refuses a
// whole ADDRESS for hours after a burst - not a query, not a minute; the
// staging host was refused every image ask for over an hour after one
// twelve-line receipt, and a manual retry by hand only extended the block
// (2026-09-06). Commons is a real API with a stated policy (a descriptive
// User-Agent, ~200 req/s), it needs no key, and for a FRESH thing it is the
// better answer anyway: "roma tomatoes" comes back as photographs of roma
// tomatoes, never a tin, because nobody uploads their shop's catalogue there.
//
// It is NOT the answer for packaged goods - a supermarket's own-brand cider is
// not on Commons - so the engine keeps that job, and Commons stands in only
// when the engine says no. Open Food Facts was tried for that half and ruled
// out: its v1 name search answers 503 as often as 200, and its v2 search
// ignores `search_terms` and pages the whole database.
import type { DdgImageResult } from "./ddg-images.js";

const ENDPOINT = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "Cobblr/1.0 (+https://cobblr.xyz; catalog picture lookup)";
const TIMEOUT_MS = 8_000;
/** Ask for a bounded rendition, not the 4000px original: the download step
 *  has a size limit, and a catalog tile does not need more. */
const THUMB_WIDTH = 800;
const BITMAP_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface CommonsPage {
  title: string;
  imageinfo?: Array<{
    url?: string;
    thumburl?: string;
    mime?: string;
    width?: number;
    height?: number;
  }>;
}

/** The search phrase for the library: the plain name, bitmaps only. The
 *  extras the engine wants ("fresh", the category, a form factor) are ranking
 *  hints for a search page; in a file-title search they only cost matches. */
export function commonsQuery(name: string): string {
  return `${name.trim()} filetype:bitmap`;
}

/** Pages -> the engine's result shape, so one ranker serves both sources.
 *  Pure; exported for the test. Drops anything that is not a bitmap photo
 *  (an SVG icon, a PDF scan, a TIFF) and anything without a rendition. */
export function commonsResultsFrom(pages: CommonsPage[] | undefined | null): DdgImageResult[] {
  const out: DdgImageResult[] = [];
  for (const p of pages ?? []) {
    const info = p.imageinfo?.[0];
    if (!info?.thumburl) continue;
    if (info.mime && !BITMAP_MIMES.has(info.mime)) continue;
    out.push({
      url: info.thumburl,
      thumb: info.thumburl,
      title: fileTitle(p.title),
      source: "commons.wikimedia.org",
      ...(info.width && info.height ? { width: info.width, height: info.height } : {}),
    });
  }
  return out;
}

/** "File:Roma Tomatoes (53512765752).jpg" -> "Roma Tomatoes (53512765752)". */
function fileTitle(title: string): string {
  return title.replace(/^File:/i, "").replace(/\.[a-z0-9]{2,5}$/i, "").trim();
}

/** How much of a file's title IS the thing. The library's search matches
 *  descriptions and categories, not only file names, so "cucumber" also
 *  answers with a photograph of farm labour that mentions cucumbers, and
 *  "baby carrots" with a plate of gnocchi that has some. A catalog tile wants
 *  the thing in frame, and the one signal we have is the title: "Real Baby
 *  Carrots" is 2/3 the name, "Zuni Cafe's Ricotta Gnocchi with Baby Carrots"
 *  is 2/7 a dish. Words of the name match singular or plural. Pure; exported
 *  for the test. */
export function nameShare(name: string, title: string): number {
  const words = title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return 0;
  const stems = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .map((w) => w.replace(/(es|s)$/, ""));
  if (stems.length === 0) return 1;
  const hits = words.filter((w) => stems.some((s) => w.startsWith(s))).length;
  return hits / words.length;
}

/** Below this the title is a scene or a dish the thing appears in. */
const MIN_NAME_SHARE = 1 / 3;

/** Never throws: a second source failing must not cost the first one's
 *  answer. An empty array is the whole failure story; the caller logs it.
 *  Asks for more than `limit` and keeps the titled ones, because the filter
 *  above is what makes the answer usable. */
export async function searchCommonsImages(name: string, limit = 12): Promise<DdgImageResult[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: commonsQuery(name),
    gsrnamespace: "6",
    gsrlimit: String(Math.min(Math.max(limit * 3, 1), 50)),
    prop: "imageinfo",
    iiprop: "url|mime|size",
    iiurlwidth: String(THUMB_WIDTH),
    format: "json",
    formatversion: "2",
  });
  try {
    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[core-scan] commons image search answered ${res.status} for ${JSON.stringify(name)}`);
      return [];
    }
    const body = (await res.json()) as { query?: { pages?: CommonsPage[] } };
    // The plainest titles first: the ranker scores studio-ness from domain
    // and shape, which every library photo shares, so this order is what
    // breaks its ties.
    return commonsResultsFrom(body.query?.pages)
      .map((r, i) => ({ r, i, share: nameShare(name, r.title) }))
      .filter((x) => x.share >= MIN_NAME_SHARE)
      .sort((a, b) => b.share - a.share || a.i - b.i)
      .map((x) => x.r)
      .slice(0, limit);
  } catch (err) {
    console.warn(`[core-scan] commons image search failed for ${JSON.stringify(name)}: ${(err as Error).message}`);
    return [];
  }
}

/** The strip's pool when both sources answered: the engine's ranked hits
 *  first (a shop photographs its own product better than a library does),
 *  the library filling what is left, and the library ALONE when the engine
 *  had nothing or refused - so a refusal is a thinner strip, not an empty
 *  one. Same picture from both collapses to one. Pure; exported for the test. */
export function mergeOptionPools(engine: DdgImageResult[], library: DdgImageResult[], limit: number): DdgImageResult[] {
  const seen = new Set<string>();
  const out: DdgImageResult[] = [];
  for (const r of [...engine, ...library]) {
    const key = r.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}
