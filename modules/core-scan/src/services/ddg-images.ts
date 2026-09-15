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
import { readWebCassette, replayingWeb, writeWebCassette } from "./web-replay.js";
import { formFactorFromObservation } from "./form-factor.js";

/** The identities the engine is asked with. The wall is scored per
 *  ADDRESS + IDENTITY, not per address alone: measured 2026-09-07 from the
 *  same container in the same minute, the identity that had been asking all
 *  day got 403 on the image endpoint while a fresh one got 200 with 77
 *  results, and an hour later the reverse. So a refusal is answered ONCE
 *  with another identity before it is called a wall (withAnotherIdentity),
 *  and the one that worked stays current. An honest bot identity is in the
 *  list on purpose: it worked as well as the browsers did. */
const AGENTS: readonly string[] = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Cobblr/1.0 (+https://cobblr.xyz; catalog picture lookup)",
  "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0",
];
const identityState = { index: 0 };

/** Ask as the current identity; on a refusal (not an unreachable engine,
 *  which is the address, not the identity) ask once more as the next one,
 *  and keep whichever answered. Exported for the test, with the identities
 *  and the cursor injectable. */
export async function withAnotherIdentity<T>(
  attempt: (agent: string) => Promise<T>,
  agents: readonly string[] = AGENTS,
  state: { index: number } = identityState,
): Promise<T> {
  const first = agents[state.index % agents.length]!;
  try {
    return await attempt(first);
  } catch (err) {
    if (!(err instanceof DdgThrottledError) || err.reason === "unreachable" || agents.length < 2) throw err;
    state.index = (state.index + 1) % agents.length;
    const next = agents[state.index]!;
    console.warn(`[core-scan] engine ${err.reason} (${err.status}) for one identity; asking again as another`);
    return await attempt(next);
  }
}

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
  "wikimedia.org",
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
// a catalog photo must get right (reported 2026-07-29), and it's legible in most
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

/** The first colour word in free text, or null — the ONE colour vocabulary the
 *  platform has, reused so a hint, a field and a title all mean the same thing
 *  by "blue". Returns the word as WRITTEN ("navy"), because that is what goes
 *  into a search phrase and onto the card; folding (grey→gray) is for comparison
 *  only. Used to read a colour out of the user's authoritative research hint
 *  ("color: blue"), which otherwise steers the identify text and nothing else. */
export function colorFromText(text: string | null | undefined): string | null {
  const words = (text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) if (COLOR_WORDS.has(w)) return w;
  return null;
}

/** A colour value that may be written into PROSE (a title, a search phrase):
 *  the value itself when it is said in words ("navy", "dark green"), null for
 *  a hex, an rgb(), or anything with a digit. A normaliser fills a colour
 *  field with a hex; that value is for the swatch and the ranking, never for a
 *  sentence. "Blue cotton yarn 100g 200m #0000FF" was a search phrase once, and
 *  "#0000ff cotton yarn 100g 200m" a title (#2885). */
export function colorWordOnly(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (!v || !colorFromText(v) || /[#\d]/.test(v)) return null;
  return v;
}
const colorsIn = (tokens: string[]): Set<string> =>
  new Set(tokens.filter((t) => COLOR_WORDS.has(t)).map((t) => COLOR_SYNONYM[t] ?? t));

// A person WEARING or USING the thing, not the product alone. we want the
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
/** Titles that say the picture is of something PRESERVED. For an item the
 *  workspace calls fresh - produce, meat, bakery, dairy - such a result is the
 *  wrong product, however well its words overlap. */
const PRESERVED_WORDS = /\b(canned|tinned|jarred|in (tomato )?juice|in brine|in water|in syrup|in oil|pickled|dried|frozen)\b|\b(can|tin|jar)\b/;

/** Categories whose members come fresh unless the name says otherwise. The
 *  workspace's own vocabulary, read off the item; nothing here decides what
 *  is food. */
export function isFreshCategory(category: string | null | undefined): boolean {
  return /\b(produce|fruit|vegetables?|veg|meat|poultry|fish|seafood|bakery|bread|dairy|deli|fresh)\b/i.test(category ?? "");
}

export function catalogScore(
  r: DdgImageResult,
  brand?: string | null,
  query?: string | null,
  knownColor?: string | null,
  /** The item is FRESH: a result that shows it canned, tinned or jarred is
   *  the wrong product. "Tomatoes Roma" off a Lidl receipt came home with a
   *  400g tin of cherry tomatoes - the shop's own-brand catalogue is mostly
   *  packaged goods and the words overlap perfectly (2026-09-06). */
  fresh?: boolean,
): number {
  let s = 0;
  if (fresh) {
    const tl0 = (r.title || "").toLowerCase();
    const ql0 = (query ?? "").toLowerCase();
    // Only when the ASK did not say tinned itself - "canned tomatoes" is a
    // real line, and its picture should be a can.
    if (PRESERVED_WORDS.test(tl0) && !PRESERVED_WORDS.test(ql0)) s -= 14;
  }
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

  // Correct COLOUR — the top visual priority. Only when the caller passes the
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
 *  page searched a bare "Farmer Boy" and got farm scenery. reported 2026-07-18.)
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
  /** What the photo pass already wrote about this item. Its FORM FACTOR
   *  sharpens the search: a bare name gets the category's most photographed
   *  member back, which is how an item its own observation called a box came
   *  home illustrated with a bottle (reported 2026-08-14). */
  observation?: string | null;
}): string | null {
  const override = (opts.override ?? "").trim();
  if (override) return override;
  const name = (opts.name ?? "").trim();
  if (!name || isJunkName(name)) return null;
  const { author, mediaWord } = mediaSearchExtras([{ fields: opts.fields ?? {} }]);
  // A colour word or nothing: the field's hex is for the swatch, not the phrase.
  const color = colorWordOnly(typeof opts.fields?.color === "string" ? (opts.fields.color as string) : null) ?? "";
  // The item's DECLARED category, on the same footing as its colour. A receipt
  // line is a bare noun with nothing else to go on - "Baby Carrots" - and the
  // search answers with the most photographed thing of that name, which for
  // fresh produce is a TIN ("cucumber, tomato, and carrots are not canned by
  // default", the operator, 2026-08-31). The workspace already said what these
  // are: Produce, Bakery, Dairy. Saying it to the search too costs nothing and
  // is the workspace's own vocabulary, not this file's opinion about food -
  // exactly how `color` and the form factor already work.
  const category = typeof opts.fields?.category === "string" ? (opts.fields.category as string).trim() : "";
  // Last: the media word separates a book from its film, which matters more
  // than the shape of the packaging, and imageQuery drops terms already in the
  // name — so a title that says "Box" does not get told twice.
  const form = formFactorFromObservation(opts.observation);
  // Category LAST of the sharpeners: it is the broadest of them, so a stronger
  // term (a creator, the colour, the observed shape) leads. imageQuery drops
  // any of these already present in the name, so a line called "Produce Bag"
  // is not told twice.
  const extra = [author, mediaWord, color, form, category].filter(Boolean).join(" ") || null;
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
  fresh?: boolean,
): DdgImageResult[] {
  return results
    .map((r, i) => ({ r, i, s: catalogScore(r, brand, query, knownColor, fresh) }))
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
 *  starving the ranker of choices. The point (stated 2026-07-29): the AI should
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

async function fetchVqd(query: string, agent: string): Promise<string> {
  // DDG's anti-automation handshake: the search page embeds a `vqd`
  // token that /i.js then requires.
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;
  const res = await askEngine(() =>
    fetch(url, {
      headers: { "User-Agent": agent, Accept: "text/html" },
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (refusedByHandshake(res.status)) throw new DdgThrottledError(res.status, "refused");
  const html = res.ok || res.status === 202 ? await res.text() : "";
  const m = html.match(/vqd=["']?([\d-]+)["']?/);
  // The token is the whole question. A 202 that carries it is a page we can
  // use (measured 2026-09-07: some identities get 202 with the token and
  // then 200 results); a 200 or 202 WITHOUT it is the challenge page, and
  // the engine is not taking the question from this identity.
  if (m?.[1]) return m[1];
  if (!res.ok && res.status !== 202) throw new Error(`DDG handshake returned ${res.status}`);
  throw new DdgThrottledError(res.status, "challenge");
}

/** 403/429 on the front door is the plain refusal. 202 is NOT one by itself:
 *  it is the challenge only when the token is missing (fetchVqd decides).
 *  Pure; exported for the test. */
export function refusedByHandshake(status: number): boolean {
  return status === 403 || status === 429;
}

/** Run one engine call and report a wall as a wall. A connection that times
 *  out or resets is the engine dropping our ADDRESS (the home IP got a TCP
 *  timeout to the engine for hours, 2026-09-06, after the 403s), and an
 *  ordinary `fetch failed` for that was read as "no picture of this
 *  product" - stamped `none` on every row, and never retried. Exported for
 *  the test. */
export async function askEngine<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (isNetworkFailure(err)) throw new DdgThrottledError(0, "unreachable");
    throw err;
  }
}

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  if (/fetch failed/i.test(err.message)) return true;
  const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
  return !!code && /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code);
}

function imageSearchOnce(query: string, limit: number): Promise<DdgImageResult[]> {
  return withAnotherIdentity((agent) => imageSearchAs(query, limit, agent));
}

async function imageSearchAs(query: string, limit: number, agent: string): Promise<DdgImageResult[]> {
  const vqd = await fetchVqd(query, agent);
  const params = new URLSearchParams({
    l: "us-en",
    o: "json",
    q: query,
    vqd,
    f: ",,,",
    p: "1",
    v7exp: "a",
  });
  const res = await askEngine(() =>
    fetch(`https://duckduckgo.com/i.js?${params}`, {
      headers: {
        "User-Agent": agent,
        Accept: "application/json",
        Referer: "https://duckduckgo.com/",
      },
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (res.status === 403 || res.status === 429) throw new DdgThrottledError(res.status, "refused");
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
/** The engine refused us, not the query. A burst from one address earns a
 *  403 for a while - the staging host returned 403 to every query for over an
 *  hour after a twelve-line receipt (2026-09-06). Filed as "no pictures" that
 *  looked like six products nobody has photographed; it was the same wall
 *  six times. Callers stamp it as BUSY and try again later.
 *
 *  Three shapes of the same wall, and the reason says which: `refused`
 *  (403/429 on the image endpoint), `challenge` (the front door serves a
 *  bot-check page instead of the token), `unreachable` (the connection itself
 *  times out or resets; status 0). */
export type EngineWall = "refused" | "challenge" | "unreachable";
export class DdgThrottledError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: EngineWall = "refused",
  ) {
    super(reason === "unreachable" ? "DDG image search unreachable" : `DDG image search ${reason} (${status})`);
    this.name = "DdgThrottledError";
  }
}

/** The ask that goes to the engine for a catalog picture.
 *
 *  For a FRESH item the shop stays OUT of the ask and is used only to rank:
 *  "Lidl Baby Carrots" answers with the shop's own-brand catalogue, which is
 *  packaged goods - a tin of peas and carrots, a tin of cherry tomatoes -
 *  because that is what a supermarket photographs. "Baby Carrots fresh" is the
 *  vegetable. Exported so the rule is a test, not a hope. */
export function coverQuery(
  name: string,
  brand: string | null | undefined,
  soldBy: string | null | undefined,
  extra: string | null | undefined,
  fresh: boolean,
): string {
  return imageQuery(name, brand || (fresh ? null : soldBy), extra);
}

/** The phrase with the shop or brand words taken out: "Lidl Chicken Breast"
 *  -> "Chicken Breast". The library AND-matches every word and no photo there
 *  is titled with a supermarket; and when the engine has nothing for the
 *  shop-prefixed phrase, the plain one is the next thing a person would type.
 *  Pure; exported for the test. */
export function withoutWords(query: string, words: string | null | undefined): string {
  const drop = new Set(
    (words ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2),
  );
  if (drop.size === 0) return query.trim();
  const kept = query.split(/\s+/).filter((w) => !drop.has(w.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const out = kept.join(" ").trim();
  return out || query.trim();
}

export async function searchImages(query: string, limit = 8): Promise<DdgImageResult[]> {
  // A recorded answer under a replay dir, never the network (web-replay.ts).
  const recorded = readWebCassette<DdgImageResult[]>("images", query);
  if (recorded) return recorded.slice(0, limit);
  if (replayingWeb()) return [];
  const ATTEMPTS = 3;
  for (let i = 0; i < ATTEMPTS; i++) {
    const out = await imageSearchOnce(query, limit);
    if (out.length > 0) {
      writeWebCassette("images", query, out);
      return out;
    }
    if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 450 * (i + 1)));
  }
  writeWebCassette("images", query, []);
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
    headers: { "User-Agent": AGENTS[identityState.index % AGENTS.length]!, Accept: "text/html", Referer: "https://duckduckgo.com/" },
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
  const recorded = readWebCassette<DdgTextResult[]>("text", query);
  if (recorded) return recorded.slice(0, limit);
  if (replayingWeb()) return [];
  const ATTEMPTS = 3;
  for (let i = 0; i < ATTEMPTS; i++) {
    const out = await textSearchOnce(query, limit);
    if (out.length > 0) {
      writeWebCassette("text", query, out);
      return out;
    }
    if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 450 * (i + 1)));
  }
  writeWebCassette("text", query, []);
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
