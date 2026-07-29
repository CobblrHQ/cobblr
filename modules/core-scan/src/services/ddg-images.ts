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

import { isJunkName } from "./enrich.js";

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

// Words that mean "several of the thing", in a RESULT's title. Penalised only
// when the query didn't ask for one — see catalogScore. Deliberately about
// plurality, not any product category: a lot of yarn, a set of chisels and a
// boxed book series are the same mistake.
const COLLECTION_WORDS = [
  "box set",
  "boxed set",
  "book set",
  "complete series",
  "complete collection",
  "full series",
  "collection of",
  "set of",
  "lot of",
  "pack of",
  "bundle of",
  "all books",
  "series set",
];

// Colours the item is KNOWN to be — from the DECLARED colour field, passed
// explicitly by the caller. "Correct colour" is the single most important thing
// a catalog photo must get right (the author, 2026-07-29), and it's legible in most
// retail titles ("… T-Shirt, Black"). Reward a result naming the SAME colour,
// penalise one naming ONLY a DIFFERENT one — a conflicting colour is a
// different SKU, the exact miss the token overlap scores as a near-match.
// Colourless titles are untouched. Synonyms fold (grey→gray).
//
// Deliberately NOT scraped from the query string (the first cut did that): a
// brand or product name carrying a colour word ("Red Heart" yarn, a
// "...Switch White" model name) would then assert a colour the item may not
// be, penalising — and with selectTopCandidates, HARD-DROPPING — the
// correctly-coloured listings. The declared field is the only trustworthy
// source (the derive-from-fields rule); no field → no colour scoring.
const COLOR_WORDS = new Set([
  "black", "white", "red", "blue", "green", "yellow", "orange", "purple",
  "pink", "brown", "gray", "grey", "silver", "gold", "beige", "tan", "navy",
  "teal", "maroon", "olive", "cyan", "magenta", "ivory", "cream", "charcoal",
  "turquoise", "burgundy", "khaki",
]);
const COLOR_SYNONYM: Record<string, string> = { grey: "gray" };
const colorsIn = (tokens: string[]): Set<string> =>
  new Set(tokens.filter((t) => COLOR_WORDS.has(t)).map((t) => COLOR_SYNONYM[t] ?? t));

// A person WEARING or USING the thing, not the product alone. the author wants the
// product itself with no human in frame; a lifestyle / on-model title is a weak
// but real signal of exactly that. Deliberately a SMALL nudge — the AI vision
// pass is the real "no people" filter — and pointedly NOT the category words
// "men's" / "women's" (a men's tee is still a clean product shot). Only phrases
// that imply a person is in the frame.
const LIFESTYLE_WORDS = [
  "on model", "on-model", "model wearing", "worn by", "styled with",
  "lookbook", "how to style", "street style", "ootd",
];

/** Catalog-quality score for one image. Higher = cleaner product shot.
 *
 *  `query` is what we searched for. It's needed because the two strongest
 *  wrong-answer signals are both RELATIVE to the request: an aspect ratio that
 *  doesn't match the thing's real shape, and a result that shows a collection
 *  when one item was asked for. */
export function catalogScore(
  r: DdgImageResult,
  brand?: string | null,
  query?: string | null,
  knownColor?: string | null,
): number {
  let s = 0;
  const host = (r.source || "").toLowerCase();
  if (CLEAN_DOMAINS.some((d) => host.includes(d))) s += 10;
  if (CLUTTERED_DOMAINS.some((d) => host.includes(d))) s -= 10;
  // The brand's own site (brand "Trader Joe's" → traderjoes.com) = clean shots.
  const b = brand ? normalize(brand) : "";
  if (b.length >= 4 && normalize(host).includes(b)) s += 8;

  // A result that shows MANY when we asked for ONE. Only counts when the query
  // itself didn't use the word: "Millennium Falcon set" legitimately wants the
  // set, and a Lego set IS the item. Searching "Little House on the Prairie"
  // and getting "…Complete Series Box Set" is the whole bug — the result
  // introduced a plurality the record never asked for.
  const ql = (query ?? "").toLowerCase();
  const tl = (r.title || "").toLowerCase();
  if (COLLECTION_WORDS.some((w) => tl.includes(w) && !ql.includes(w))) s -= 8;

  // Does the RESULT actually name the thing we asked for? Nothing checked this
  // before: brand scoring only looked at the HOST, so "Guliter 17 Inch Tool Bag"
  // and "VANTOR 17 in. Tool Tote" scored identically for a Vantor tote, and an
  // "X1 Extreme Gen 5" tied with the ThinkBook 4319-2NU someone actually owned.
  // Both were the wrong product, and both said so in the title. (Measured from
  // real human overrides, 2026-07-20.)
  const qTokens = ql.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (qTokens.length) {
    const hit = qTokens.filter((t) => tl.includes(t)).length;
    s += Math.round((hit / qTokens.length) * 6); // 0..6 by how much of the ask it names

    // A token carrying a digit is an IDENTIFIER — a model, a SKU, a size. If the
    // query named one and the result names none of them, it is very likely a
    // different variant of the right family, which is the failure that survives
    // every other signal here.
    const ident = qTokens.filter((t) => /\d/.test(t));
    if (ident.length) s += ident.some((t) => tl.includes(t)) ? 4 : -6;
  }

  // Correct COLOUR — the author's top visual priority. Only when the caller passes the
  // item's DECLARED colour (never scraped from the query — see COLOR_WORDS):
  // a result naming the SAME colour is very likely the right variant; one
  // naming ONLY a DIFFERENT colour is the wrong variant the token overlap
  // above would otherwise score as a near-match ("… T-Shirt, Red" for a black
  // shirt shares every token but the colour). A colourless title is untouched.
  const wantColors = colorsIn(
    (knownColor ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
  );
  if (wantColors.size) {
    const tTokens = tl.split(/[^a-z0-9]+/).filter(Boolean);
    const haveColors = colorsIn(tTokens);
    if ([...haveColors].some((c) => wantColors.has(c))) s += 4;
    else if (haveColors.size) s -= 5;
  }

  // A person WEARING/USING the thing when we want the product alone (weak
  // signal; the AI vision re-rank is the real "no people" filter).
  if (LIFESTYLE_WORDS.some((w) => tl.includes(w))) s -= 3;

  if (r.width && r.height) {
    const ar = r.width / r.height;
    // NOT a square bias. Square-ish used to earn +4 on the theory that a
    // product shot is square — but that only holds for boxed retail goods. A
    // book cover, a bottle, a poster and a phone are all PORTRAIT, so the old
    // rule scored the correct answer 0 and handed +4 to the square group photo
    // sitting next to it. Anything from a tall-ish portrait to a mild landscape
    // is a plausible single object; only genuine banners and panoramas are not.
    if (ar >= 0.5 && ar <= 1.6) s += 3;
    else if (ar < 0.4 || ar > 2) s -= 4; // banner / sliver
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

/** THE image-search phrase for anything the platform can photograph — the one
 *  derivation every surface uses, so a book gets the same query whether you're
 *  looking at it in the scan inbox or on its record page. (They diverged once:
 *  the inbox produced "Farmer Boy Laura Ingalls Wilder book" while a record
 *  page searched a bare "Farmer Boy" and got farm scenery. the author, 2026-07-18.)
 *
 *  `fields` is any field bag — a scan candidate's `fields`, or a resolved
 *  entity's. Everything is derived from DECLARED FIELDS (a creator key, a
 *  media key, a colour), never from a hardcoded noun, so a Movies list or a
 *  wine shelf sharpens exactly like the Bookshelf does.
 *
 *  Returns null when the name is junk ("Unknown Item", a bare barcode): better
 *  no options than a strip of "?" bags. */
export function deriveImageQuery(opts: {
  name: string | null | undefined;
  brand?: string | null;
  fields?: Record<string, unknown> | null;
  /** A user-typed term wins outright — search EXACTLY what they asked for. */
  override?: string | null;
}): string | null {
  const override = (opts.override ?? "").trim();
  if (override) return override;
  const name = (opts.name ?? "").trim();
  if (!name || isJunkName(name)) return null;
  const { author, mediaWord } = mediaSearchExtras([{ fields: opts.fields ?? {} }]);
  const color = typeof opts.fields?.color === "string" ? (opts.fields.color as string).trim() : "";
  const extra = [author, mediaWord, color].filter(Boolean).join(" ") || null;
  return imageQuery(name, opts.brand ?? null, extra);
}

/** Reorder image options best-catalog-first (stable on ties). `knownColor` is
 *  the item's DECLARED colour field when the caller has one — never a scraped
 *  guess (see the COLOR_WORDS note). */
export function rankImageOptions(
  results: DdgImageResult[],
  brand?: string | null,
  query?: string | null,
  knownColor?: string | null,
): DdgImageResult[] {
  return results
    .map((r, i) => ({ r, i, s: catalogScore(r, brand, query, knownColor) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r);
}

/** A dedupe key for two results that are effectively the same picture: same
 *  host + same final path segment (filename), ignoring the query string. Two
 *  retailers serving different files stay distinct; the same product image
 *  linked twice collapses to one. */
function imageDedupeKey(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() ?? u.pathname;
    return `${u.hostname.toLowerCase()}/${seg.toLowerCase()}`;
  } catch {
    return url.toLowerCase();
  }
}

/** The candidate set to hand the AI rank pass: rank by catalog quality, dedupe
 *  near-identical shots, then HARD-DROP the clearly-bad (net-negative score:
 *  social/cluttered domain, wrong-colour title, banner, placeholder) — but only
 *  while enough clearly-good remain. A thin pool keeps everything rather than
 *  starving the ranker of choices. The point (the author's, 2026-07-29): the AI should
 *  be selecting the best of N GOOD candidates, not rescuing a strip of junk —
 *  the heuristic does as much filtering as titles/domains/dimensions allow, and
 *  the AI does the pixel calls (a person in frame, the true colour) the
 *  heuristic can't. Pure; exported for the guardrail test. */
export function selectTopCandidates(
  results: DdgImageResult[],
  brand: string | null | undefined,
  query: string | null | undefined,
  budget: number,
  knownColor?: string | null,
): DdgImageResult[] {
  const ranked = rankImageOptions(results, brand, query, knownColor);
  const seen = new Set<string>();
  const deduped = ranked.filter((r) => {
    const k = imageDedupeKey(r.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const positives = deduped.filter((r) => catalogScore(r, brand, query, knownColor) >= 0);
  // Keep the good-only set only when it's substantial enough to choose from;
  // otherwise a sparse query would send the AI one or two images.
  const pool = positives.length >= 3 ? positives : deduped;
  return pool.slice(0, Math.max(0, budget));
}

/** A CLEARLY clean catalog shot — safe to auto-set as the item's image without a
 *  human pick (retail/brand domain). Conservative on purpose. */
export function isCleanCatalog(
  r: DdgImageResult,
  brand?: string | null,
  query?: string | null,
): boolean {
  return catalogScore(r, brand, query) >= 10;
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
