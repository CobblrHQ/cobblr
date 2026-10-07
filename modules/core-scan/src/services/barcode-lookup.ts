// Barcode lookup: go-upc.com first (authoritative — curated data, never
// a wrong-product answer; see tryGoUpc for the politeness contract),
// then two free API providers fired concurrently as the fallback.
//
// The hard-won lesson: the
// upcitemdb FREE TRIAL endpoint is a single global bucket shared by every
// trial user on the internet, so it returns its rate-limit codes (`TOO_FAST`
// burst, `EXCEED_LIMIT` daily) *constantly* — often on the very first call.
// A rate-limit is NOT a "this product doesn't exist" miss: it's "ask again
// later." Conflating the two is fatal, because the orchestrator caches misses
// — so a rate-limited scan would poison the cache with a PERMANENT miss for a
// real product (the classic "scanned my yarn, got nothing, re-scan still
// nothing" bug). So this returns a discriminated outcome and the caller must
// NOT cache `rate_limited`.
//
// Provider preference: go-upc (curated) > upcitemdb (crowdsourced; decent
// retail/craft coverage but can return junk or wrong listings) > Open Products
// Facts (food/household-leaning, almost no craft coverage).

import { gtinChecksumOk, isbn10ChecksumOk } from "@cobblr/platform-contract/identifier-check";
import { STORE_CODE_NOTE } from "@cobblr/platform-contract/scan-copy";
import { preferredFactsName, primaryBrand } from "./catalog-normalize.js";
import { isBookSource, replayMiss, writeCatalogCassette } from "./catalog-replay.js";

export interface BarcodeHit {
  source: "upcitemdb" | "openproductsfacts" | "go-upc" | string;
  title: string;
  brand: string | null;
  model: string | null;
  description: string | null;
  category: string | null;
  image_url: string | null;
  raw: Record<string, unknown>;
  /** A DECODED identifier's semantic bag (an ISBN's title / author / year /
   *  isbn / publisher), keyed in the decoder's own vocabulary. The fill lands
   *  each key on the destination field that declares `decode:<key>`, and the
   *  identifier itself on the one declaring `identifier:<decoderId>`, so the
   *  words never have to match a field's name. Absent for a plain product hit. */
  fields?: Record<string, string | number>;
  /** The registry id the fields decode under (`isbn`). Present iff `fields` is. */
  decoder_id?: string;
  /** Which tier answered THIS install, apart from `source` (where the data
   *  came from): the barcode network relays go-upc's answer as source
   *  "go-upc", and a check read that as a direct call (#3713). Kept on `raw`
   *  too, so a cached hit still says it. */
  via?: BarcodeVia;
}

export type BarcodeVia = "bidb" | "resolver" | "direct";

function withVia(hit: BarcodeHit, via: BarcodeVia): BarcodeHit {
  return { ...hit, via, raw: { ...hit.raw, via } };
}

export type BarcodeOutcome =
  | { outcome: "hit"; hit: BarcodeHit }
  // `refused`: a catalog answered, but not with the kind of thing the code
  // says it is (a food for a book's ISBN, #3674). No answer for the caller,
  // and not a definitive one either: the right catalog has not been heard.
  | { outcome: "miss"; refused?: BarcodeHit; unconfirmed?: true }
  // A provider was reachable but throttled and no other provider had the
  // product. The UPC is UNRESOLVED, not absent — the caller must leave the
  // cache untouched so a later scan retries.
  | { outcome: "rate_limited"; scope: "burst" | "daily" }
  // Configured, reachable, and it refused this install's key, with nothing else
  // resolving the code. Same invariant as rate_limited: UNRESOLVED, not absent, so
  // the caller must not cache it. Without this, an install misconfigured for an hour
  // negative-caches every code it scans and fixing the key does not bring them back
  // until those entries expire.
  //
  // `unreachable`: a catalog that was asked and could not answer (the network, a
  // timeout, a 5xx) while nothing else resolved the code. An absence cannot
  // clear a negative: a miss is definitive only when every catalog asked said
  // no, so this too is UNRESOLVED and never cached. Read as a miss, one evening
  // of a provider being down cached every code scanned in it as absent, for
  // this workspace with no expiry and for every other for thirty days.
  | { outcome: "unavailable"; reason: "auth" | "unreachable" };

/** The two outcomes a cache may keep. The others are UNRESOLVED, and the
 *  comment above asking callers not to cache them was ignored for a year
 *  (`unavailable` was negative-cached until 2026-09-17): a writer that takes
 *  THIS type cannot be handed them, and `durableOutcome` is the one place
 *  that lists what durable means, positively, so an outcome added later is
 *  unresolved until someone says otherwise here. */
export type DurableBarcodeOutcome = Extract<BarcodeOutcome, { outcome: "hit" | "miss" }>;
export function durableOutcome(o: BarcodeOutcome): DurableBarcodeOutcome | null {
  // A refused answer is not "no such product": caching it as a miss would
  // stop the book catalog ever being asked for that ISBN again.
  if (o.outcome === "miss" && o.refused) return null;
  // The network said it could not ask yet (its primary still working): no
  // answer for this scan, and no absence either, so nothing is cached and the
  // next scan asks again, when the network has the real answer (#3713).
  if (o.outcome === "miss" && o.unconfirmed) return null;
  return o.outcome === "hit" || o.outcome === "miss" ? o : null;
}

// upcitemdb's trial can be slow under load; give it room. OPF is snappy.
const UPCITEMDB_TIMEOUT_MS = 12_000;
const OPF_TIMEOUT_MS = 10_000;

type ProviderResult =
  | { kind: "hit"; hit: BarcodeHit }
  | { kind: "miss"; unconfirmed?: true }
  | { kind: "rate_limited"; scope: "burst" | "daily" }
  // Asked and could not answer: a 5xx, a timeout, the network. Not a miss.
  | { kind: "unreachable" };

const UNREACHABLE: ProviderResult = { kind: "unreachable" };
/** A thrown fetch (timeout, DNS, reset) is the catalog not answering. */
const unreachableOnThrow = (): ProviderResult => UNREACHABLE;

async function fetchJson(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "cobblr-core-scan/0.2", accept: "application/json", ...headers },
      signal: controller.signal,
    });
    // A 429's body says which kind it is (a key over its limit, or a network
    // that could not ask yet), and a 404's whether it is provisional, so both
    // are read too (#3713).
    const body = res.ok || res.status === 429 || res.status === 404 ? await res.json().catch(() => null) : null;
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function tryUpcitemdb(upc: string): Promise<ProviderResult> {
  // Paid key ⇒ the /prod endpoint (own quota); else the shared free /trial
  // bucket (see the header comment). Same response shape either way.
  const key = process.env.COBBLR_SCAN_UPCITEMDB_KEY?.trim();
  const { status, body } = await fetchJson(
    key
      ? `https://api.upcitemdb.com/prod/v1/lookup?upc=${encodeURIComponent(upc)}`
      : `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`,
    UPCITEMDB_TIMEOUT_MS,
    key ? { user_key: key, key_type: "3scale" } : {},
  );
  // HTTP 429 = daily quota spent.
  if (status === 429) return { kind: "rate_limited", scope: "daily" };
  if (status >= 500) return UNREACHABLE;
  const data = body as { code?: string; total?: number; items?: Array<Record<string, unknown>> } | null;
  // The trial signals throttling in the 200-body too: TOO_FAST = the 15/30s
  // burst cap, EXCEED_LIMIT = the daily quota. Treat BOTH as retryable, never
  // as a miss — this is the whole point of the rewrite.
  if (data?.code === "TOO_FAST") return { kind: "rate_limited", scope: "burst" };
  if (data?.code === "EXCEED_LIMIT") return { kind: "rate_limited", scope: "daily" };
  if (!data || !Array.isArray(data.items) || data.items.length === 0) return { kind: "miss" };
  const item = data.items[0]!;
  const title = String(item.title ?? "").trim();
  if (!title) return { kind: "miss" }; // a row with no name is no better than a miss
  const images = Array.isArray(item.images) ? (item.images as string[]) : [];
  return {
    kind: "hit",
    hit: {
      source: "upcitemdb",
      title,
      brand: typeof item.brand === "string" ? item.brand : null,
      model: typeof item.model === "string" ? item.model : null,
      description: typeof item.description === "string" ? item.description : null,
      category: typeof item.category === "string" ? item.category : null,
      image_url: images.find((u) => typeof u === "string" && u.length > 0) ?? null,
      raw: item,
    },
  };
}

// The Open Facts family — same API v2 shape, different databases. A given UPC
// usually lives in exactly one: general products in OPF, groceries in OFF,
// cosmetics in OBF. All free + keyless, so we fire all three concurrently and
// take whichever has it. (OFF/OBF added 2026-06-16 — broadens free coverage,
// trims paid-GoUPC spend, and enriches the cache / barcode-DB.)
const OPEN_FACTS_DBS: ReadonlyArray<{ host: string; source: string }> = [
  { host: "world.openproductsfacts.org", source: "openproductsfacts" },
  { host: "world.openfoodfacts.org", source: "openfoodfacts" },
  { host: "world.openbeautyfacts.org", source: "openbeautyfacts" },
];

/** The catalog's most specific ENGLISH category ("en:cow-cheeses" reads
 *  "Cow cheeses"). `categories` is written in the product's own language, so a
 *  French cheese said "Fromages de vache", which nothing downstream reads: the
 *  storage rules, the shelf buckets and routing all speak English. The tags are
 *  the catalog's normalised taxonomy, general to specific; a tag that is not a
 *  clean English slug is a contributor's free text and is passed over. */
export function openFactsCategory(p: Record<string, unknown>): string | null {
  const tags = Array.isArray(p.categories_tags) ? p.categories_tags.filter((t): t is string => typeof t === "string") : [];
  const english = tags.filter((t) => /^en:[a-z0-9-]+$/.test(t));
  const last = english[english.length - 1];
  if (last) {
    const words = last.slice(3).replace(/-/g, " ").trim();
    if (words) return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return typeof p.categories === "string" ? p.categories.split(",")[0]?.trim() || null : null;
}

async function tryOpenFacts(upc: string, host: string, source: string): Promise<ProviderResult> {
  const { status, body } = await fetchJson(
    `https://${host}/api/v2/product/${encodeURIComponent(upc)}.json`,
    OPF_TIMEOUT_MS,
  );
  // A 404 is the catalog saying it has no such product; a 5xx is it not answering.
  if (status >= 500) return UNREACHABLE;
  const data = body as { status?: number; product?: Record<string, unknown> } | null;
  if (!data || data.status !== 1 || !data.product) return { kind: "miss" };
  const p = data.product;
  // Which of the record's OWN name fields to believe. Only this adapter can
  // make that call, because only it sees the alternatives — the funnel above
  // receives one title and has nothing to choose between.
  const name = preferredFactsName(p);
  if (!name) return { kind: "miss" };
  return {
    kind: "hit",
    hit: {
      source,
      title: name.trim(),
      // Brand cleaning is the funnel's job (see normalizeOutcome); passing the
      // raw field is correct here rather than each adapter remembering.
      brand: typeof p.brands === "string" ? p.brands : null,
      model: null,
      description: typeof p.generic_name === "string" ? p.generic_name : null,
      category: openFactsCategory(p),
      image_url:
        (typeof p.image_front_url === "string" && p.image_front_url) ||
        (typeof p.image_url === "string" && p.image_url) ||
        null,
      raw: p,
    },
  };
}

// ── go-upc.com — the "use the website" tier ──────────────────────────
// Go-UPC is the PRIMARY/authoritative provider (the author, 2026-06-10): its
// data is curated where the API providers are crowdsourced and can
// return outright WRONG products — and a wrong auto-fill is worse than
// a miss, because it gets trusted and cached. It also has the best
// hardware/craft coverage we've seen (it resolved a Southwire
// electrical box both free APIs missed). Its public /search page serves
// the data as plain, stable HTML; their robots.txt explicitly ALLOWS
// /search (only /api/v1/code/ is disallowed) with `Crawl-delay: 10`,
// so this scrapes politely:
//   • ≥10s between requests (the crawl-delay) — and the gate NEVER
//     QUEUES: if the slot isn't nearly free, the lookup SKIPS go-upc
//     and the APIs answer instead. An unbounded in-process queue
//     stacked 10s×N under CI's concurrent scans, stalled enrichments
//     past their orgs' teardown, and 500'd on dead tenant pools.
//     Human-paced scanning virtually never trips the skip.
//   • the orchestrator caches every outcome cross-tenant, so a UPC hits
//     their site at most once, ever — that invariant, not call order,
//     is what keeps the volume tiny,
//   • honest User-Agent (their pages 200 fine without impersonation).
// If scan volume outgrows the alpha, switch this tier to their paid API
// — same parse target, official transport.

const GO_UPC_SPACING_MS = 10_000;
// How long a lookup is willing to wait for the crawl-delay slot before
// skipping go-upc for this scan. Small on purpose: the skip path is the
// burst-pressure release valve.
const GO_UPC_MAX_WAIT_MS = 1_500;
let goUpcLastAt = 0;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Exported for the smoke script (scripts/test-barcode-goupc.ts).
// HTTP 400 ("Invalid Barcode") and the "Product Not Found" page are
// definitive misses. Transport errors AND a busy crawl-delay slot
// throw — the call site degrades them to "go-upc had no answer" and
// falls to the API providers.
export async function tryGoUpc(upc: string): Promise<ProviderResult> {
  // Honor the crawl-delay — but NEVER queue behind it (see the header
  // comment: a queue here stalls scans under concurrency). Slot busy →
  // skip; the APIs answer this scan.
  //
  // The slot is RESERVED synchronously, before any await: the old
  // read-check-sleep-set shape let two concurrent scans both observe a clear
  // gate across the sleep and double-fire against the Crawl-delay contract.
  const now = Date.now();
  const slotAt = Math.max(now, goUpcLastAt + GO_UPC_SPACING_MS);
  if (slotAt - now > GO_UPC_MAX_WAIT_MS) throw new Error("go-upc slot busy — skipped for this scan");
  goUpcLastAt = slotAt;
  if (slotAt > now) await new Promise((r) => setTimeout(r, slotAt - now));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`https://go-upc.com/search?q=${encodeURIComponent(upc)}`, {
      headers: {
        accept: "text/html",
        "user-agent": "cobblr-core-scan/0.2 (respects Crawl-delay)",
      },
      signal: controller.signal,
    });
    if (res.status === 400) return { kind: "miss" }; // checksum-invalid code
    if (!res.ok) throw new Error(`go-upc HTTP ${res.status}`);
    const html = await res.text();
    if (/<title>\s*Product Not Found/i.test(html)) return { kind: "miss" };

    const h1 = html.match(/<h1[^>]*class="product-name"[^>]*>([\s\S]*?)<\/h1>/i);
    const title = h1 ? decodeEntities(h1[1]!.replace(/<[^>]+>/g, "").trim()) : "";
    if (!title) return { kind: "miss" };

    // ALL images go into raw (cache every field); the structured
    // image_url column gets the first.
    const figureImgs = [
      ...html.matchAll(/class="product-image[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/gi),
    ].map((m) => m[1]!);
    const s3Imgs = [...html.matchAll(/https:\/\/go-upc\.s3[^"'\s]+/gi)].map((m) => m[0]);
    const images = [...new Set([...figureImgs, ...s3Imgs])];
    const img = images[0] ?? null;

    // The metadata table: <td class="metadata-label">Brand</td><td>…</td>
    const meta: Record<string, string> = {};
    for (const m of html.matchAll(
      /<td[^>]*class="metadata-label"[^>]*>([^<]+)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi,
    )) {
      meta[m[1]!.trim().replace(/:$/, "").toLowerCase()] = decodeEntities(
        m[2]!.replace(/<[^>]+>/g, "").trim(),
      );
    }
    // "Additional Attributes" — <li><span class="metadata-label">Key:</span>
    // Value</li>. Spec gold (Material / Color / Size…): exactly the
    // field-fill fodder the matchmaker extracts into table fields.
    const attributes: Record<string, string> = {};
    for (const m of html.matchAll(
      /<li[^>]*>\s*<span[^>]*class="metadata-label"[^>]*>([^<]+)<\/span>([\s\S]*?)<\/li>/gi,
    )) {
      const k = m[1]!.trim().replace(/:$/, "").toLowerCase();
      const v = decodeEntities(m[2]!.replace(/<[^>]+>/g, "").trim());
      if (k && v) attributes[k] = v;
    }
    // Description: the old product-description div, or the current
    // "Description</h2><span>…</span>" shape.
    const desc =
      html.match(/class="product-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ??
      html.match(/Description\s*<\/h2>\s*<span[^>]*>([\s\S]*?)<\/span>/i);
    const description = desc
      ? decodeEntities(desc[1]!.replace(/<[^>]+>/g, "").trim()) || null
      : null;

    return {
      kind: "hit",
      hit: {
        source: "go-upc",
        title,
        brand: meta["brand"] || null,
        model: null,
        description,
        category: meta["category"] || null,
        image_url: img,
        // EVERYTHING the page gave us — the full metadata table, the
        // attributes list, every image, the description — so the cache
        // row loses nothing even where the structured columns flatten.
        raw: { title, meta, attributes, images, description },
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── external-lookup gating (self-host privacy) ────────────────────────
// A master switch + per-provider toggles/keys let an operator control exactly
// which third-party barcode services this instance contacts, and supply API
// keys where a provider offers one. See docs/SELF_HOSTING.md → Privacy.
//   COBBLR_SCAN_EXTERNAL_LOOKUPS   master (default on); off = no third-party barcode calls
//   COBBLR_SCAN_GOUPC_API_KEY      go-upc: set ⇒ official API (clean transport)
//   COBBLR_SCAN_GOUPC              go-upc HTML scraper — default OFF (opt-in only)
//   COBBLR_SCAN_UPCITEMDB / _KEY   upcitemdb (default on); key ⇒ paid endpoint
//   COBBLR_SCAN_OPENFACTS          Open Facts trio (default on; free open data)
//   COBBLR_SCAN_WEBSEARCH          DuckDuckGo web-search fallback (default on)
export function envBool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return dflt;
  return !/^(false|0|off|no)$/i.test(v.trim());
}
export const externalLookupsEnabled = (): boolean => envBool("COBBLR_SCAN_EXTERNAL_LOOKUPS", true);
export const webSearchEnabled = (): boolean => externalLookupsEnabled() && envBool("COBBLR_SCAN_WEBSEARCH", true);

// go-upc OFFICIAL API — the clean transport (no scraping) when the operator
// supplies a key. Same product target as the /search scrape, official endpoint.
async function tryGoUpcApi(upc: string, key: string): Promise<ProviderResult> {
  const { status, body } = await fetchJson(
    `https://go-upc.com/api/v1/code/${encodeURIComponent(upc)}`,
    12_000,
    { authorization: `Bearer ${key}` },
  );
  if (status === 404) return { kind: "miss" };
  if (status === 429) return { kind: "rate_limited", scope: "daily" };
  if (status >= 500) return UNREACHABLE;
  const p = (body as { product?: Record<string, unknown> } | null)?.product;
  if (!p) return { kind: "miss" };
  const title = typeof p.name === "string" ? p.name.trim() : "";
  if (!title) return { kind: "miss" };
  return {
    kind: "hit",
    hit: {
      source: "go-upc",
      title,
      brand: typeof p.brand === "string" ? p.brand : null,
      model: null,
      description: typeof p.description === "string" ? p.description : null,
      category: typeof p.category === "string" ? p.category : null,
      image_url: typeof p.imageUrl === "string" ? p.imageUrl : null,
      raw: p,
    },
  };
}

// ── box-level resolver tier ───────────────────────────────────────────
// When COBBLR_BARCODE_RESOLVER_URL is set, the shared resolver on the
// host owns the whole provider chain — one go-upc politeness gate, one
// upcitemdb daily budget, one cache for EVERY product on the box (every Cobblr instance). A UPC scanned anywhere warms everyone. The
// resolver is a READ-ONLY proxy: this client can't write into it, so a
// compromised instance can't poison results others render. See the box.s own
// barcode-resolver service. Throws on transport failure so
// lookupBarcode falls back to resolving locally.
async function tryResolver(upc: string): Promise<ProviderResult> {
  const base = (process.env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
  const controller = new AbortController();
  // Generous hang-guard: a live go-upc read behind the resolver queue can
  // take ~20s; the scan route's own inline deadline owns responsiveness.
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(`${base}/lookup?upc=${encodeURIComponent(upc)}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${process.env.COBBLR_BARCODE_RESOLVER_TOKEN ?? ""}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`resolver HTTP ${res.status}`);
    const d = (await res.json()) as {
      found: boolean;
      source: string;
      cache: "hit" | "live";
      took_ms: number;
      resolved_at: string;
      rate_limited?: boolean;
      product: {
        title: string;
        brand: string | null;
        model: string | null;
        description: string | null;
        category: string | null;
        image_url: string | null;
        raw?: unknown;
      } | null;
    };
    if (d.found && d.product?.title) {
      return {
        kind: "hit",
        hit: {
          source: d.source,
          title: d.product.title,
          brand: d.product.brand,
          model: d.product.model,
          description: d.product.description,
          category: d.product.category,
          image_url: d.product.image_url,
          // Provenance both ways: the provider payload + what THIS
          // request cost (cache hit vs live read) for the viewers.
          raw: {
            ...(typeof d.product.raw === "object" && d.product.raw ? (d.product.raw as object) : {}),
            resolver: { cache: d.cache, took_ms: d.took_ms, resolved_at: d.resolved_at, confidence: (d as { confidence?: unknown }).confidence },
          } as Record<string, unknown>,
        },
      };
    }
    if (d.rate_limited) return { kind: "rate_limited", scope: "daily" };
    return { kind: "miss" };
  } finally {
    clearTimeout(timer);
  }
}

// ── BIdb: the hosted, cross-install intelligence tier ─────────────────
// The public sibling of the box resolver above. Where COBBLR_BARCODE_RESOLVER_URL
// is ONE deployment's private shared cache (tailnet-only), BIdb (bidb.cobblr.xyz)
// is the hosted, cross-install brain: it serves known results fast and, for our
// own first-party tiers, resolves live behind one shared quota. A per-install key
// selects the tier server-side — first-party (live-lookup, full data) vs external
// read-only cache — and the server strips commercial-sourced fields for external
// keys, so this client renders whatever it is handed with no redistribution
// concern of its own. See docs/design-decisions/barcode-intelligence-db.md.
//
//   COBBLR_BIDB_URL   set ⇒ query BIdb (default on for the trial tier; opt-in for
//                     self-host). Unset ⇒ this tier is inert (ships dark).
//   COBBLR_BIDB_KEY   per-install key, issued from a Cobblr account; sent as a
//                     bearer token; determines the tier + the data class returned.
//
// Unlike the box resolver, a BIdb MISS is NOT definitive: it falls through to the
// rest of the chain so a self-host still reaches its own providers. A throttle is
// surfaced upward, never cached as a miss (the no-poison rule). Operator-configured
// infra ⇒ plain fetch, strict-egress-safe (the env-set-URL convention, CLAUDE.md
// §14.1).
const BIDB_TIMEOUT_MS = 12_000;

export const bidbEnabled = (): boolean => Boolean(process.env.COBBLR_BIDB_URL?.trim());

// Deliberately NO exported key-state helper here. The api reports configuration state
// by reading the env directly, because importing a module's internals across the
// isolation boundary is not allowed, and bidbEnabled() stays URL-only on purpose: the
// SERVER decides whether a request is allowed (it 401s an unkeyed one today), so
// letting it serve anonymous reads later needs no client change.

// One line per process for a standing configuration fault, not one per scanned barcode.
let bidbAuthWarned = false;

export async function tryBidb(upc: string): Promise<ProviderResult> {
  const base = (process.env.COBBLR_BIDB_URL ?? "").replace(/\/+$/, "");
  const key = process.env.COBBLR_BIDB_KEY?.trim();
  const { status, body } = await fetchJson(
    `${base}/v1/barcode/${encodeURIComponent(upc)}`,
    BIDB_TIMEOUT_MS,
    key ? { authorization: `Bearer ${key}` } : {},
  );
  // A provisional 404: every source that answered in time said no, but the
  // network's primary is still looking. A miss for this scan, never cached,
  // so a product the slower source knows is not hidden behind it (#3713).
  if (status === 404 && (body as { provisional?: unknown } | null)?.provisional === true) return { kind: "miss", unconfirmed: true };
  if (status === 404) return { kind: "miss" }; // known-absent — safe to cache
  // "degraded": the network could not confirm the code within its deadline and
  // is still asking its primary. A miss for THIS scan, which goes on to its
  // own providers and the web at once rather than waiting out a retry
  // schedule; unconfirmed, so it is never cached (#3713). Any other 429 is
  // this key over its fair-use limit.
  if (status === 429 && (body as { error?: unknown } | null)?.error === "degraded") return { kind: "miss", unconfirmed: true };
  if (status === 429) return { kind: "rate_limited", scope: "daily" }; // over fair-use
  // 401/403 is not a transport problem, it is a CONFIGURATION one: the URL is set and
  // reachable, the key is missing, wrong or revoked. Marked so the caller can say that
  // instead of "unreachable", which sends an operator looking at the network.
  if (status === 401 || status === 403) {
    throw Object.assign(new Error(`bidb rejected the key (HTTP ${status})`), { bidbAuth: true });
  }
  if (status !== 200) throw new Error(`bidb HTTP ${status}`); // transport-ish → fall through
  // A hit is a flat product record (barcode-intelligence-db.md §3.5).
  const p = body as {
    name?: unknown;
    brand?: unknown;
    model?: unknown;
    description?: unknown;
    category?: unknown;
    image_url?: unknown;
    source?: unknown;
    confidence?: unknown;
  } | null;
  const title = typeof p?.name === "string" ? p.name.trim() : "";
  if (!p || !title) return { kind: "miss" };
  return {
    kind: "hit",
    hit: {
      source: typeof p.source === "string" && p.source ? p.source : "bidb",
      title,
      brand: typeof p.brand === "string" ? p.brand : null,
      model: typeof p.model === "string" ? p.model : null,
      description: typeof p.description === "string" ? p.description : null,
      category: typeof p.category === "string" ? p.category : null,
      image_url: typeof p.image_url === "string" ? p.image_url : null,
      // Preserve confidence + any extra server fields for the cache row.
      raw: { bidb: p },
    },
  };
}

/**
 * Resolve a UPC: go-upc first (authoritative), then the API providers
 * concurrently as the fallback.
 *
 * - go-upc HIT wins outright — curated data, never a wrong-product answer,
 *   and a hit spends none of upcitemdb's 100/day quota.
 * - else (go-upc miss, busy-skip, or transport error) → upcitemdb ‖ the Open
 *   Facts trio (products/food/beauty); upcitemdb HIT preferred, else the first
 *   Open Facts hit.
 * - else if upcitemdb was rate-limited → `rate_limited` (caller must NOT cache;
 *   the product is unresolved, not absent — retry later or fall to web search).
 * - else `miss` (a genuine "no catalog has this", safe to cache).
 *
 * A thrown/transport error from any provider degrades to a miss for THAT
 * provider, never crashes the lookup.
 */
/**
 * Could this string even BE a product barcode? UPC/EAN/GTIN are pure DIGITS at
 * fixed lengths (UPC-E 8, UPC-A 12, EAN-13, GTIN-14); ISBN-10 is 9 digits plus a
 * 0-9/X check character.
 *
 * Anything else is not a product code, and asking a product database about it is
 * how you get a confident wrong answer. A mangled VIN (`I2HKRL18662H580289` — 18
 * alphanumeric chars) reached a product lookup on 2026-07-14 and came back as
 * "Reverse Phone", with a photo of a travel trailer, which became the item's name
 * and cover image. The provider was never going to say "that's a VIN": it only
 * knows how to return its best match. So the shape gate has to be ours.
 */
export { gtinChecksumOk, isbn10ChecksumOk };

/** GS1 restricted-circulation numbers: EAN-13 prefixes 02, 04 and 20 to 29
 *  (a 12-digit UPC-A leading 2 or 4 is the same code with its leading 0
 *  dropped; a GTIN-14 carries a packaging indicator ahead of the 13). They are
 *  a shop's own labels: variable-weight deli and produce, loyalty stubs, an
 *  in-store SKU. The number means something only inside the shop that printed
 *  it, so no global catalog can know it, and any hit is a coincidence in
 *  somebody's database. A synthetic 2000000000015 typed into Scan resolved to
 *  a real milk product and sat in the inbox as an identification (2026-09-12).
 *  The checksum is still required: a mis-read of a real product's code is a
 *  mis-read, not a store code. EAN-8 is left alone here. */
export function hasStoreCodePrefix(code: string): boolean {
  const c = code.trim();
  if (!/^\d{12,14}$/.test(c)) return false;
  const gtin13 = c.length === 12 ? `0${c}` : c.length === 14 ? c.slice(1) : c;
  return /^(02|04|2[0-9])/.test(gtin13);
}

export function isStoreCode(code: string): boolean {
  return hasStoreCodePrefix(code) && gtinChecksumOk(code.trim());
}

/** What a store's own label is stamped with the moment it is inserted:
 *  the verdict is known from the prefix alone, so the row never spends a
 *  second reading "Identifying..." on any surface (#3017). Null for any
 *  other code, which the lookup answers later. The enrich pass re-stamps
 *  the same on a re-run. */
export function storeCodeInsertStamps(code: string | null | undefined): { ai_notes: string; ai_confidence: string; ai_suggested_at: Date; code_type: "store-code" } | null {
  if (!code || !isStoreCode(code)) return null;
  return { ai_notes: STORE_CODE_NOTE, ai_confidence: "0", ai_suggested_at: new Date(), code_type: "store-code" };
}

export function looksLikeProductBarcode(code: string): boolean {
  const c = code.trim().toUpperCase();
  // A valid GTIN that is a shop's own label is still not a PRODUCT code: no
  // provider can answer, so none is asked. lookupBarcode's miss then costs no
  // quota and caches nothing.
  if (isStoreCode(c)) return false;
  // 8-digit codes are deliberately NOT checksummed: the scan can be EAN-8
  // (standard GTIN checksum) or UPC-E (check digit computed over the EXPANDED
  // UPC-A form), and the digits alone don't say which — running the wrong
  // algorithm would reject real labels. Length stays the only gate here.
  if (/^\d{8}$/.test(c)) return true; // EAN-8 / UPC-E
  // 12/13/14-digit GTINs have one unambiguous checksum: a mis-read or
  // transposed digit fails here and becomes an honest, quota-free miss
  // instead of a confident wrong product from a lookup provider.
  if (/^\d{12,14}$/.test(c)) return gtinChecksumOk(c); // UPC-A / EAN-13 / GTIN-14
  if (/^\d{9}[\dX]$/.test(c)) return isbn10ChecksumOk(c); // ISBN-10
  return false;
}

// Coalesce concurrent lookups of the SAME code — a burst of scans of one
// unlabeled box, or several devices hitting one new UPC: the first caller pays
// the provider round; the rest await its outcome. Entry cleared on settle so a
// later scan retries fresh (a rate_limited outcome must stay retryable).
const inflightLookups = new Map<string, Promise<BarcodeOutcome>>();

export async function lookupBarcode(upc: string): Promise<BarcodeOutcome> {
  const norm = upc.trim();
  if (!norm) return { outcome: "miss" };
  // Never ask a product database about something that cannot be a product code.
  // A miss is the honest answer, and it costs no quota to give.
  if (!looksLikeProductBarcode(norm)) return { outcome: "miss" };
  // A replay dir answers from its cassettes and never from the network
  // (catalog-replay.ts): a test's catalog is a fixture, not a service.
  const replayed = replayMiss(norm);
  if (replayed) return agreeWithCode(norm, normalizeOutcome(replayed));
  const existing = inflightLookups.get(norm);
  if (existing) return existing;
  // Normalise HERE, not in the adapters. Five provider tiers return a hit and
  // seven downstream sites write its brand, so a rule enforced per-adapter is
  // one that N-1 adapters eventually miss — which is exactly what had happened:
  // the Open*Facts adapter split the brand synonym list and the resolver tier
  // twenty lines below it passed the same field straight through. This is the
  // one point every tier's answer converges on, so a new provider inherits the
  // cleaning by existing.
  const p = doLookupBarcode(norm)
    .then(normalizeOutcome)
    .then((outcome) => agreeWithCode(norm, outcome))
    .then((outcome) => {
      writeCatalogCassette(norm, outcome);
      return outcome;
    })
    .finally(() => inflightLookups.delete(norm));
  inflightLookups.set(norm, p);
  return p;
}

/** What a code's own structure says the thing is, where it says anything.
 *  An EAN-13 in the Bookland range (978, 979 but not 979-0, which is printed
 *  music) is an ISBN, and an ISBN names a book; a valid ISBN-10 too. Any
 *  other code says nothing about its category. */
export function codeKindOf(code: string): "book" | null {
  const c = code.trim().toUpperCase();
  if (/^97(8\d|9[1-9])\d{9}$/.test(c) && gtinChecksumOk(c)) return "book";
  if (/^\d{9}[\dX]$/.test(c) && isbn10ChecksumOk(c)) return "book";
  return null;
}

/** Whether a catalog's answer is the kind of thing the code says it is. A
 *  book: a book catalog's answer, or one carrying the ISBN decode or a books
 *  category. */
export function answerAgreesWithCode(code: string, hit: BarcodeHit): boolean {
  if (codeKindOf(code) !== "book") return true;
  return isBookSource(hit.source) || hit.decoder_id === "isbn" || /\bbooks?\b/i.test(hit.category ?? "");
}

/** A catalog's answer is taken only when it agrees with what the code's own
 *  structure says it is (#3674). Open Food Facts holds an entry for
 *  9781449373320, "Fit Shake", and that is the ISBN of Designing
 *  Data-Intensive Applications: a mis-entered code on their side, and
 *  confident nonsense on ours. An ISBN no book source answered is a miss
 *  here, so the caller asks the book catalog (enrich.ts, resolveIsbn) and
 *  never files a food. Every tier and a replayed cassette converge on this
 *  one point, so a tier added later inherits it. */
function agreeWithCode(code: string, outcome: BarcodeOutcome): BarcodeOutcome {
  if (outcome.outcome !== "hit" || answerAgreesWithCode(code, outcome.hit)) return outcome;
  console.log(`[core-scan] ${code} is a book's ISBN; ${outcome.hit.source} answered "${outcome.hit.title}", which is not a book, so it is not taken`);
  return { outcome: "miss", refused: outcome.hit };
}

function normalizeOutcome(outcome: BarcodeOutcome): BarcodeOutcome {
  if (outcome.outcome !== "hit") return outcome;
  return { ...outcome, hit: { ...outcome.hit, brand: primaryBrand(outcome.hit.brand) } };
}

/** An Open Facts record's categories, read directly when a resolver or BIdb
 *  answer carried the name and brand from its Open Facts mirror but not them
 *  (#5102). The categories are what routes a food with no AI: Barilla Rigatoni
 *  from the box resolver arrived with `category: null` and no
 *  `categories_tags`, so nothing named pasta, and in a Groceries-only
 *  workspace it filed as an Inventory part beside Nutella in Groceries. The
 *  read is the same free, keyless one the direct chain makes, under the same
 *  switches; it never changes the answer's name, brand or picture, and a
 *  failure leaves the answer as it came. */
async function withFactsCategories(norm: string, hit: BarcodeHit): Promise<BarcodeHit> {
  if (hit.category) return hit;
  const raw = (hit.raw && typeof hit.raw === "object" ? hit.raw : {}) as Record<string, unknown>;
  if (Array.isArray(raw.categories_tags) && raw.categories_tags.length > 0) return hit;
  const db = OPEN_FACTS_DBS.find((d) => d.source === hit.source || d.source === raw.facts_mirror);
  if (!db || !externalLookupsEnabled() || !envBool("COBBLR_SCAN_OPENFACTS", true)) return hit;
  const r = await tryOpenFacts(norm, db.host, db.source).catch((): ProviderResult => ({ kind: "miss" }));
  if (r.kind !== "hit") return hit;
  const p = (r.hit.raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(p.categories_tags) && !r.hit.category) return hit;
  return {
    ...hit,
    category: r.hit.category,
    description: hit.description ?? r.hit.description,
    raw: { ...raw, categories_tags: p.categories_tags, ...(typeof p.categories === "string" ? { categories: p.categories } : {}) },
  };
}

async function doLookupBarcode(norm: string): Promise<BarcodeOutcome> {

  // Box-level resolver first (when configured): the host-wide chain —
  // one cache, one go-upc gate, one quota budget. Its answer (hit, miss,
  // or rate_limited) is DEFINITIVE; only a transport failure falls
  // through to resolving locally.
  if (process.env.COBBLR_BARCODE_RESOLVER_URL) {
    try {
      const r = await tryResolver(norm);
      if (r.kind === "hit") return { outcome: "hit", hit: withVia(await withFactsCategories(norm, r.hit), "resolver") };
      if (r.kind === "rate_limited") return { outcome: "rate_limited", scope: r.scope };
      return { outcome: "miss" };
    } catch (e) {
      console.error(`[core-scan] barcode resolver unreachable (${(e as Error).message}) — falling back to local chain`);
    }
  }

  // BIdb tier (hosted, cross-install). Hit wins; a miss falls through so a
  // self-host still reaches its own providers; a throttle is remembered so a
  // BIdb-only tier (the trial: external lookups off) never caches a rate-limit
  // as a permanent miss (the no-poison rule).
  let bidbThrottled = false;
  let bidbAuthFailed = false;
  let bidbUnreachable = false;
  let bidbUnconfirmed = false;
  if (bidbEnabled()) {
    try {
      const r = await tryBidb(norm);
      if (r.kind === "hit") return { outcome: "hit", hit: withVia(await withFactsCategories(norm, r.hit), "bidb") };
      if (r.kind === "rate_limited") bidbThrottled = true;
      if (r.kind === "miss" && r.unconfirmed) bidbUnconfirmed = true;
    } catch (e) {
      if ((e as { bidbAuth?: boolean }).bidbAuth) {
        bidbAuthFailed = true;
        // A standing misconfiguration, so say it ONCE and say what to do. Repeating it
        // per scan buried it, and calling it "unreachable" pointed at the wrong thing.
        if (!bidbAuthWarned) {
          bidbAuthWarned = true;
          console.error(
            `[core-scan] BIdb rejected this install's key (${(e as Error).message}). Every lookup will ` +
              `fall back to the local providers until COBBLR_BIDB_KEY is set to a valid key. ` +
              `A URL without a key is not enough: the key is what selects the tier and the data class. ` +
              // Naming where a key comes from is most of this line's value. An operator
              // reading it in their own logs should not then have to go looking.
              `Get one at https://account.cobblr.xyz`,
          );
        }
      } else {
        bidbUnreachable = true;
        console.error(`[core-scan] bidb unreachable (${(e as Error).message}) — falling back to local chain`);
      }
    }
  }
  // No hit anywhere. Definitive only when every catalog asked actually
  // answered no; a throttle, a refused key or a catalog that could not answer
  // leaves the code UNRESOLVED, which the caller never caches.
  const noHit = (unreachable: boolean): BarcodeOutcome =>
    bidbThrottled
      ? { outcome: "rate_limited", scope: "daily" }
      : bidbAuthFailed
        ? { outcome: "unavailable", reason: "auth" }
        : unreachable || bidbUnreachable
          ? { outcome: "unavailable", reason: "unreachable" }
          : bidbUnconfirmed
            ? { outcome: "miss", unconfirmed: true }
            : { outcome: "miss" };

  // Third-party direct lookups — master switch (self-host privacy). Off ⇒ no
  // external barcode calls at all; only the cache + box resolver (above) answer.
  if (!externalLookupsEnabled()) return noHit(false);

  // go-upc tier. A supplied API key uses the OFFICIAL API (clean transport);
  // otherwise the HTML scraper runs ONLY when explicitly opted in
  // (COBBLR_SCAN_GOUPC) — OFF by default, so we never ship a scraper that runs
  // unasked. A busy crawl-delay slot / transport error degrades to "no answer"
  // and the API providers decide.
  const goUpcKey = process.env.COBBLR_SCAN_GOUPC_API_KEY?.trim();
  let goRes: ProviderResult = { kind: "miss" };
  if (goUpcKey) {
    goRes = await tryGoUpcApi(norm, goUpcKey).catch(unreachableOnThrow);
  } else if (envBool("COBBLR_SCAN_GOUPC", false)) {
    // The scraper's own "slot busy" is a skip for this scan, not the catalog
    // failing to answer: the APIs decide, and a miss from them stands.
    goRes = await tryGoUpc(norm).catch((): ProviderResult => ({ kind: "miss" }));
  }
  if (goRes.kind === "hit") return { outcome: "hit", hit: withVia(goRes.hit, "direct") };

  // Fallback: upcitemdb ‖ Open Facts trio, each independently toggleable.
  const upcP: Promise<ProviderResult> = envBool("COBBLR_SCAN_UPCITEMDB", true)
    ? tryUpcitemdb(norm).catch(unreachableOnThrow)
    : Promise.resolve({ kind: "miss" });
  const factsP: Promise<ProviderResult[]> = envBool("COBBLR_SCAN_OPENFACTS", true)
    ? Promise.all(OPEN_FACTS_DBS.map((db) => tryOpenFacts(norm, db.host, db.source).catch(unreachableOnThrow)))
    : Promise.resolve([]);
  const [upcRes, factsRes] = await Promise.all([upcP, factsP]);

  if (upcRes.kind === "hit") return { outcome: "hit", hit: withVia(upcRes.hit, "direct") };
  const factsHit = factsRes.find((r) => r.kind === "hit");
  if (factsHit && factsHit.kind === "hit") return { outcome: "hit", hit: withVia(factsHit.hit, "direct") };

  // No catalog hit. If upcitemdb was throttled, the answer is
  // "unknown, retry" — not "doesn't exist".
  if (upcRes.kind === "rate_limited") return { outcome: "rate_limited", scope: upcRes.scope };
  return noHit([goRes, upcRes, ...factsRes].some((r) => r.kind === "unreachable"));
}

/** Did this answer come from ONE person's confirmation on the barcode network
 *  (a code no catalogue knows, named once, #3769)? The network serves it so the
 *  next person needs no AI, marked so it is shown lightly and can be corrected:
 *  confidence "single" from the resolver, 0.5 through the edge. */
export function namedByOnePerson(hit: BarcodeHit | null | undefined): boolean {
  const raw = (hit?.raw ?? {}) as { bidb?: { confidence?: unknown }; resolver?: { confidence?: unknown } };
  return raw.bidb?.confidence === 0.5 || raw.resolver?.confidence === "single";
}
