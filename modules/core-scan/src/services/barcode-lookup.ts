// Barcode lookup against two free providers, fired concurrently.
// Inspired by companion app/api/src/services/barcode-lookup.ts but
// streamlined for v0.1: no rate-limit typed-error rerouting yet,
// no web-search fallback. Both providers are keyless; the
// upcitemdb free tier rate-limits aggressively (100/day) so we
// degrade gracefully to Open Products Facts.
//
// Output: a normalized `BarcodeHit | null`. The caller decides
// what to do on a miss (today: leave the inbox row barcode-only,
// user fills in manually).

export interface BarcodeHit {
  source: "upcitemdb" | "openproductsfacts";
  title: string;
  brand: string | null;
  model: string | null;
  description: string | null;
  category: string | null;
  image_url: string | null;
  raw: Record<string, unknown>;
}

const TIMEOUT_MS = 6_000;

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "cobblr-core-scan/0.1", ...headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { __status: res.status };
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function tryUpcitemdb(upc: string): Promise<BarcodeHit | null> {
  // Free trial tier: https://www.upcitemdb.com/wp/docs/main/development/free-tier/
  // 100/day, 15/30s burst. Returns 429 on rate limit — we treat
  // that as "miss" and lean on the other provider. Future v0.2:
  // typed `BarcodeRateLimitError` so the caller can NOT cache the
  // miss (per the companion app impl).
  const data = await fetchJson(
    `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(upc)}`,
  ) as { items?: Array<Record<string, unknown>>; __status?: number };
  if (!data || data.__status || !Array.isArray(data.items) || data.items.length === 0) {
    return null;
  }
  const item = data.items[0]!;
  const images = Array.isArray(item.images) ? (item.images as string[]) : [];
  return {
    source: "upcitemdb",
    title: String(item.title ?? "").trim(),
    brand: typeof item.brand === "string" ? item.brand : null,
    model: typeof item.model === "string" ? item.model : null,
    description: typeof item.description === "string" ? item.description : null,
    category: typeof item.category === "string" ? item.category : null,
    image_url: images[0] ?? null,
    raw: item as Record<string, unknown>,
  };
}

async function tryOpenProductsFacts(upc: string): Promise<BarcodeHit | null> {
  // OPF is part of the OFF family. The v2 API returns 200 with
  // `status: 0` on a miss; 200 with `status: 1` on a hit.
  const data = await fetchJson(
    `https://world.openproductsfacts.org/api/v2/product/${encodeURIComponent(upc)}.json`,
  ) as {
    status?: number;
    product?: Record<string, unknown>;
    __status?: number;
  };
  if (!data || data.__status || data.status !== 1 || !data.product) return null;
  const p = data.product;
  const name =
    (typeof p.product_name === "string" && p.product_name) ||
    (typeof p.generic_name === "string" && p.generic_name) ||
    "";
  if (!name) return null;
  return {
    source: "openproductsfacts",
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
  };
}

/** Concurrent race — return the first non-null hit. If both
 *  return null we return null. If both throw, we return null
 *  silently (the inbox row stays barcode-only and the user can
 *  fill in manually). */
export async function lookupBarcode(upc: string): Promise<BarcodeHit | null> {
  const norm = upc.trim();
  if (!norm) return null;

  const settled = await Promise.allSettled([
    tryOpenProductsFacts(norm),
    tryUpcitemdb(norm),
  ]);
  // Prefer OPF when both hit — it tends to have richer metadata
  // for grocery / household items, and upcitemdb's free-tier
  // results are often spam-flagged. Both are valid hits; this is
  // just a tie-breaker.
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}
