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
    results?: Array<{ image?: string; thumbnail?: string; title?: string; url?: string; source?: string }>;
  };
  return (data.results ?? [])
    .filter((it) => !!it.image)
    .slice(0, limit)
    .map((it) => ({
      url: it.image!,
      thumb: it.thumbnail ?? it.image!,
      title: it.title ?? "",
      source: hostnameFromUrl(it.url) || it.source || "",
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
