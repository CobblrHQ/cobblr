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

export interface BarcodeHit {
  source: "upcitemdb" | "openproductsfacts" | "go-upc" | string;
  title: string;
  brand: string | null;
  model: string | null;
  description: string | null;
  category: string | null;
  image_url: string | null;
  raw: Record<string, unknown>;
}

export type BarcodeOutcome =
  | { outcome: "hit"; hit: BarcodeHit }
  | { outcome: "miss" }
  // A provider was reachable but throttled and no other provider had the
  // product. The UPC is UNRESOLVED, not absent — the caller must leave the
  // cache untouched so a later scan retries.
  | { outcome: "rate_limited"; scope: "burst" | "daily" };

// upcitemdb's trial can be slow under load; give it room. OPF is snappy.
const UPCITEMDB_TIMEOUT_MS = 12_000;
const OPF_TIMEOUT_MS = 10_000;

type ProviderResult =
  | { kind: "hit"; hit: BarcodeHit }
  | { kind: "miss" }
  | { kind: "rate_limited"; scope: "burst" | "daily" };

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
    const body = res.ok ? await res.json().catch(() => null) : null;
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

async function tryOpenFacts(upc: string, host: string, source: string): Promise<ProviderResult> {
  const { body } = await fetchJson(
    `https://${host}/api/v2/product/${encodeURIComponent(upc)}.json`,
    OPF_TIMEOUT_MS,
  );
  const data = body as { status?: number; product?: Record<string, unknown> } | null;
  if (!data || data.status !== 1 || !data.product) return { kind: "miss" };
  const p = data.product;
  const name =
    (typeof p.product_name === "string" && p.product_name) ||
    (typeof p.generic_name === "string" && p.generic_name) ||
    "";
  if (!name) return { kind: "miss" };
  return {
    kind: "hit",
    hit: {
      source,
      title: name.trim(),
      brand: typeof p.brands === "string" ? p.brands.split(",")[0]?.trim() ?? null : null,
      model: null,
      description: typeof p.generic_name === "string" ? p.generic_name : null,
      category: typeof p.categories === "string" ? p.categories.split(",")[0]?.trim() ?? null : null,
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
            resolver: { cache: d.cache, took_ms: d.took_ms, resolved_at: d.resolved_at },
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

export async function tryBidb(upc: string): Promise<ProviderResult> {
  const base = (process.env.COBBLR_BIDB_URL ?? "").replace(/\/+$/, "");
  const key = process.env.COBBLR_BIDB_KEY?.trim();
  const { status, body } = await fetchJson(
    `${base}/v1/barcode/${encodeURIComponent(upc)}`,
    BIDB_TIMEOUT_MS,
    key ? { authorization: `Bearer ${key}` } : {},
  );
  if (status === 404) return { kind: "miss" }; // known-absent — safe to cache
  if (status === 429) return { kind: "rate_limited", scope: "daily" }; // over fair-use
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
/** GTIN mod-10 check-digit test. From the rightmost digit excluding the check,
 *  weights alternate 3,1,3,1…; valid when the computed check matches. */
export function gtinChecksumOk(digits: string): boolean {
  const check = Number(digits[digits.length - 1]);
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === check;
}

/** ISBN-10 mod-11 check (final char may be X = 10). */
export function isbn10ChecksumOk(code: string): boolean {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(code[i]);
  const last = code[9] === "X" ? 10 : Number(code[9]);
  return (sum + last) % 11 === 0;
}

export function looksLikeProductBarcode(code: string): boolean {
  const c = code.trim().toUpperCase();
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
  const existing = inflightLookups.get(norm);
  if (existing) return existing;
  const p = doLookupBarcode(norm).finally(() => inflightLookups.delete(norm));
  inflightLookups.set(norm, p);
  return p;
}

async function doLookupBarcode(norm: string): Promise<BarcodeOutcome> {

  // Box-level resolver first (when configured): the host-wide chain —
  // one cache, one go-upc gate, one quota budget. Its answer (hit, miss,
  // or rate_limited) is DEFINITIVE; only a transport failure falls
  // through to resolving locally.
  if (process.env.COBBLR_BARCODE_RESOLVER_URL) {
    try {
      const r = await tryResolver(norm);
      if (r.kind === "hit") return { outcome: "hit", hit: r.hit };
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
  if (bidbEnabled()) {
    try {
      const r = await tryBidb(norm);
      if (r.kind === "hit") return { outcome: "hit", hit: r.hit };
      if (r.kind === "rate_limited") bidbThrottled = true;
    } catch (e) {
      console.error(`[core-scan] bidb unreachable (${(e as Error).message}) — falling back to local chain`);
    }
  }
  const throttledMiss = (): BarcodeOutcome =>
    bidbThrottled ? { outcome: "rate_limited", scope: "daily" } : { outcome: "miss" };

  // Third-party direct lookups — master switch (self-host privacy). Off ⇒ no
  // external barcode calls at all; only the cache + box resolver (above) answer.
  if (!externalLookupsEnabled()) return throttledMiss();

  // go-upc tier. A supplied API key uses the OFFICIAL API (clean transport);
  // otherwise the HTML scraper runs ONLY when explicitly opted in
  // (COBBLR_SCAN_GOUPC) — OFF by default, so we never ship a scraper that runs
  // unasked. A busy crawl-delay slot / transport error degrades to "no answer"
  // and the API providers decide.
  const goUpcKey = process.env.COBBLR_SCAN_GOUPC_API_KEY?.trim();
  let goRes: ProviderResult = { kind: "miss" };
  if (goUpcKey) {
    goRes = await tryGoUpcApi(norm, goUpcKey).catch((): ProviderResult => ({ kind: "miss" }));
  } else if (envBool("COBBLR_SCAN_GOUPC", false)) {
    goRes = await tryGoUpc(norm).catch((): ProviderResult => ({ kind: "miss" }));
  }
  if (goRes.kind === "hit") return { outcome: "hit", hit: goRes.hit };

  // Fallback: upcitemdb ‖ Open Facts trio, each independently toggleable.
  const upcP: Promise<ProviderResult> = envBool("COBBLR_SCAN_UPCITEMDB", true)
    ? tryUpcitemdb(norm).catch((): ProviderResult => ({ kind: "miss" }))
    : Promise.resolve({ kind: "miss" });
  const factsP: Promise<ProviderResult[]> = envBool("COBBLR_SCAN_OPENFACTS", true)
    ? Promise.all(
        OPEN_FACTS_DBS.map((db) =>
          tryOpenFacts(norm, db.host, db.source).catch((): ProviderResult => ({ kind: "miss" })),
        ),
      )
    : Promise.resolve([]);
  const [upcRes, factsRes] = await Promise.all([upcP, factsP]);

  if (upcRes.kind === "hit") return { outcome: "hit", hit: upcRes.hit };
  const factsHit = factsRes.find((r) => r.kind === "hit");
  if (factsHit && factsHit.kind === "hit") return { outcome: "hit", hit: factsHit.hit };

  // No catalog hit. If upcitemdb was throttled, the answer is
  // "unknown, retry" — not "doesn't exist".
  if (upcRes.kind === "rate_limited") return { outcome: "rate_limited", scope: upcRes.scope };
  return throttledMiss();
}
