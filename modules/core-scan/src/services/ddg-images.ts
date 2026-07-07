// Thin wrapper around DuckDuckGo's unofficial image-search JSON
// endpoint. No API key, no per-day quota — the "always works" default
// for a self-hosted install. DDG soft-rate-limits per source IP; for a
// triage session (a few queries) it never trips. A barcode that misses
// the catalog DBs gets web-searched here: each result carries a title
// (a candidate product name) and an image URL (a candidate photo), so
// one call yields both.
//
// Single-tenant / low-volume only — don't fan this out from a public
// multi-tenant path without a per-tenant rate budget (core-ai is the
// natural throttle for the LLM half; this half is best-effort).

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface DdgImageResult {
  /** Original (upstream) image URL. */
  url: string;
  /** DDG-hosted thumbnail. */
  thumb: string;
  /** Page/result title — a product-name candidate. */
  title: string;
  /** Hostname of the page the image was found on. */
  source: string;
  /** Pixel dimensions (DDG provides them) — for aspect-ratio quality scoring. */
  width?: number;
  height?: number;
}

// Catalog-quality ranking: the FIRST DDG hit is rarely the cleanest — it's often
// a recipe blog / social / styled photo (cluttered, watermarked). A retailer or
// brand product page serves a clean studio shot on white. So float retail/brand
// domains + square-ish images up, sink social/blogs. Free, no AI; the clean
// catalog photo lands near the front instead of buried at #6-7.
const CLEAN_DOMAINS = [
  "amazon.", "target.com", "walmart.com", "instacart.com", "samsclub.com", "costco.com",
  "kroger.com", "traderjoes.com", "wholefoodsmarket.com", "heb.com", "meijer.com", "wegmans.com",
  "iherb.com", "thrivemarket.com", "ebay.com", "barcodelookup.com", "go-upc.com",
  "openfoodfacts.org", "openproductsfacts.org", "upcitemdb.com", "shopify",
];
const CLUTTERED_DOMAINS = [
  "pinterest.", "instagram.", "facebook.", "twitter.", "x.com", "reddit.", "tiktok.",
  "youtube.", "tumblr.", "blogspot.", "wordpress.", "medium.com", "yelp.",
];
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Catalog-quality score for one image. Higher = cleaner product shot. */
export function catalogScore(r: DdgImageResult, brand?: string | null): number {
  let s = 0;
  const host = (r.source || "").toLowerCase();
  if (CLEAN_DOMAINS.some((d) => host.includes(d))) s += 10;
  if (CLUTTERED_DOMAINS.some((d) => host.includes(d))) s -= 10;
  // The brand's own site (brand "Trader Joe's" → traderjoes.com) = clean shots.
  const b = brand ? normalize(brand) : "";
  if (b.length >= 4 && normalize(host).includes(b)) s += 8;
  if (r.width && r.height) {
    const ar = r.width / r.height;
    if (ar >= 0.8 && ar <= 1.25) s += 4; // square-ish → product shot
    else if (ar < 0.5 || ar > 2) s -= 4; // banner / tall lifestyle
    if (r.width < 200) s -= 3; // tiny
  }
  return s;
}

/** Build an image-search query that puts the BRAND in the query, not just the
 *  ranking. A generic name like "Blended Scotch Whiskey" matches any scotch (a
 *  Kirkland item came back as Johnnie Walker), and ranking by brand can't help
 *  when no on-brand image is in the generic pool. Skips the brand when the name
 *  ALREADY carries it — the full string, or all of the brand's significant
 *  (3+ char) words already appear — so we never emit "Kirkland Signature
 *  Kirkland Signature …". */
export function imageQuery(name: string, brand?: string | null, extra?: string | null): string {
  const n = (name ?? "").trim();
  const b = (brand ?? "").trim();
  // Extra terms sharpen a weak title: an author + a media word ("book") turns
  // "Farmer Boy" (which finds generic farm images) into "Farmer Boy Laura
  // Ingalls Wilder book" (the actual cover). Appended, deduped against the name.
  const ex = (extra ?? "").trim();
  const withExtra = (q: string): string => {
    if (!ex) return q;
    const ql = q.toLowerCase();
    const parts = ex.split(/\s+/).filter((w) => w.length >= 2 && !ql.includes(w.toLowerCase()));
    return parts.length ? `${q} ${parts.join(" ")}`.trim() : q;
  };
  if (!b) return withExtra(n);
  const nl = n.toLowerCase();
  if (nl.includes(b.toLowerCase())) return withExtra(n);
  const brandWords = b.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (brandWords.length > 0 && brandWords.every((w) => nl.includes(w))) return withExtra(n);
  return withExtra(`${b} ${n}`.trim());
}

/** Search-sharpening extras derived from an item's matchmaker candidates: an
 *  author/creator (much stronger than a publisher for a book) + a media-type
 *  word so a bare title finds the actual cover, not generic theme images.
 *  Generic (any titled-media field), nothing book-specific hardcoded. */
export function mediaSearchExtras(
  candidates: Array<{ fields?: Record<string, unknown> }> | null | undefined,
): { author: string | null; mediaWord: string | null } {
  const creatorKeys = ["author", "artist", "director", "composer", "writer"];
  const mediaByKey: Record<string, string> = { isbn: "book", author: "book", director: "movie", artist: "album", issn: "magazine" };
  let author: string | null = null;
  let mediaWord: string | null = null;
  for (const c of candidates ?? []) {
    const f = c.fields ?? {};
    for (const k of Object.keys(f)) {
      const lk = k.toLowerCase();
      if (!author && creatorKeys.includes(lk) && typeof f[k] === "string" && (f[k] as string).trim()) author = (f[k] as string).trim();
      if (!mediaWord && mediaByKey[lk]) mediaWord = mediaByKey[lk];
    }
  }
  return { author, mediaWord };
}

/** Reorder image options best-catalog-first (stable on ties). */
export function rankImageOptions(results: DdgImageResult[], brand?: string | null): DdgImageResult[] {
  return results
    .map((r, i) => ({ r, i, s: catalogScore(r, brand) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r);
}

/** A CLEARLY clean catalog shot — safe to auto-set as the item's image without a
 *  human pick (retail/brand domain). Conservative on purpose. */
export function isCleanCatalog(r: DdgImageResult, brand?: string | null): boolean {
  return catalogScore(r, brand) >= 10;
}

async function fetchVqd(query: string): Promise<string> {
  // DDG's anti-automation handshake: the search page embeds a `vqd`
  // token that /i.js then requires.
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DDG handshake returned ${res.status}`);
  const html = await res.text();
  const m = html.match(/vqd=["']?([\d-]+)["']?/);
  if (!m || !m[1]) throw new Error("DDG vqd token not found");
  return m[1];
}

async function imageSearchOnce(query: string, limit: number): Promise<DdgImageResult[]> {
  const vqd = await fetchVqd(query);
  const params = new URLSearchParams({
    l: "us-en",
    o: "json",
    q: query,
    vqd,
    f: ",,,",
    p: "1",
    v7exp: "a",
  });
  const res = await fetch(`https://duckduckgo.com/i.js?${params}`, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: "https://duckduckgo.com/",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DDG image search returned ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ image?: string; thumbnail?: string; title?: string; url?: string; source?: string; width?: number; height?: number }>;
  };
  return (data.results ?? [])
    .filter((it) => !!it.image)
    .slice(0, limit)
    .map((it) => ({
      url: it.image!,
      thumb: it.thumbnail ?? it.image!,
      title: it.title ?? "",
      source: hostnameFromUrl(it.url) || it.source || "",
      width: typeof it.width === "number" ? it.width : undefined,
      height: typeof it.height === "number" ? it.height : undefined,
    }));
}

/**
 * DDG's image endpoint (/i.js) is anti-bot-gated on a shared/datacenter IP and
 * frequently returns an EMPTY result set even when the same query has results in
 * a browser — observed in the field: "images empty but the web search has the
 * right results." A fresh vqd handshake on a second/third try usually recovers
 * it, so retry-on-empty (with a small backoff) before giving up. A thrown error
 * (429 / handshake fail) is a different failure mode → surface it, don't retry
 * here. Returns [] only after every attempt came back genuinely empty.
 */
export async function searchImages(query: string, limit = 8): Promise<DdgImageResult[]> {
  const ATTEMPTS = 3;
  for (let i = 0; i < ATTEMPTS; i++) {
    const out = await imageSearchOnce(query, limit);
    if (out.length > 0) return out;
    if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 450 * (i + 1)));
  }
  return [];
}

export interface DdgTextResult {
  /** Result title — the strongest product-name candidate for a bare UPC. */
  title: string;
  /** Result URL (DDG redirect form). */
  url: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

async function textSearchOnce(query: string, limit: number): Promise<DdgTextResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA, Accept: "text/html", Referer: "https://duckduckgo.com/" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DDG text search returned ${res.status}`);
  const html = await res.text();
  const out: DdgTextResult[] = [];
  const re = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const href = m[1] ?? "";
    const rawTitle = m[2] ?? "";
    const title = decodeEntities(rawTitle.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (title) out.push({ title, url: decodeEntities(href) });
  }
  return out;
}

/**
 * DDG TEXT/web search (html.duckduckgo.com). Unlike the image endpoint, the text
 * index DOES resolve a bare UPC to its retail product pages (Amazon/Target/eBay
 * titles) — observed in the field: a UPC that returns NO image results yields a
 * clean "Cuisinart Chef's Classic Nonstick…" title here. So this is the reliable
 * name-grounding source for the web-search fallback. Retry-on-empty for the same
 * anti-bot flakiness the image endpoint has.
 */
export async function searchText(query: string, limit = 10): Promise<DdgTextResult[]> {
  const ATTEMPTS = 3;
  for (let i = 0; i < ATTEMPTS; i++) {
    const out = await textSearchOnce(query, limit);
    if (out.length > 0) return out;
    if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 450 * (i + 1)));
  }
  return [];
}

function hostnameFromUrl(u: string | undefined): string {
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
