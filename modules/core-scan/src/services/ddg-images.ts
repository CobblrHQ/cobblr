// Thin wrapper around DuckDuckGo's unofficial image-search JSON
// endpoint. No API key, no per-day quota — the "always works" default
// for a self-hosted install. DDG soft-rate-limits per source IP; for a
// triage session (a few queries) it never trips. A barcode that misses
// the catalog DBs gets web-searched here: each result carries a title
// (a candidate product name) and an image URL (a candidate photo), so
// one call yields both. Ported from companion app's ddg-images.ts.
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

export async function searchImages(query: string, limit = 8): Promise<DdgImageResult[]> {
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

function hostnameFromUrl(u: string | undefined): string {
  if (!u) return "";
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
