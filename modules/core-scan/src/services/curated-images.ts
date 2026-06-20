// Curated-first image lookup. The on-the-fly DDG image search guesses a real but
// often WRONG model (a Prusa MK4 photo for a Prusa Mini). For known machines we'd
// rather hand-pick the image. This reads a small manifest — `{ entries: [{
// manufacturer, family, image }] }` — from an operator-configured URL
// (COBBLR_CATALOG_IMAGES_MANIFEST, e.g. the raw manifest in CobblrHQ/printer-images)
// and matches a query against it. Edit the manifest → it updates here within the
// cache TTL, no Cobblr redeploy. A miss falls back to the DDG search as before.
//
// The matched `image` is a PUBLIC URL; it still flows through the same
// SSRF-guarded fetchAndStoreImage in entity-image.ts, so this only chooses WHICH
// url to fetch — it doesn't widen what's fetchable.

interface CuratedEntry {
  manufacturer?: string;
  family?: string;
  image: string;
}
interface Manifest {
  version?: number;
  entries: CuratedEntry[];
}

const TTL_MS = 5 * 60_000; // edits to the manifest show up within 5 min
let cache: { at: number; data: Manifest | null } | null = null;

async function loadManifest(): Promise<Manifest | null> {
  const url = process.env.COBBLR_CATALOG_IMAGES_MANIFEST;
  if (!url) return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    // Optional bearer for a private manifest host (e.g. a private Forgejo repo's
    // raw URL needs a read token; without it Forgejo serves an HTML login page).
    const token = process.env.COBBLR_CATALOG_IMAGES_TOKEN;
    const headers: Record<string, string> = { "user-agent": "cobblr-core-scan/0.1" };
    if (token) headers.Authorization = `token ${token}`;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    const data = r.ok ? ((await r.json()) as Manifest) : null;
    cache = { at: Date.now(), data: data && Array.isArray(data.entries) ? data : null };
    return cache.data;
  } catch {
    // Cache the miss too, so a flaky/unreachable manifest doesn't stall every
    // enrich with a 5s fetch; it retries after the TTL.
    cache = { at: Date.now(), data: null };
    return null;
  }
}

/** Best curated image URL for a free-text query (e.g. "Prusa Mini 3D printer"),
 *  or null. An entry matches when the query contains its family (and manufacturer,
 *  when given); the most specific family wins so "A1 mini" beats "A1". */
export async function curatedImageUrl(query: string): Promise<string | null> {
  const manifest = await loadManifest();
  if (!manifest) return null;
  const q = query.toLowerCase();
  const hits = manifest.entries.filter((e) => {
    const fam = (e.family ?? "").toLowerCase().trim();
    const mfr = (e.manufacturer ?? "").toLowerCase().trim();
    return !!e.image && (!fam || q.includes(fam)) && (!mfr || q.includes(mfr)) && (!!fam || !!mfr);
  });
  hits.sort((a, b) => (b.family ?? "").length - (a.family ?? "").length);
  return hits[0]?.image ?? null;
}

/** Test seam — drop the cached manifest. */
export function _resetCuratedCache(): void {
  cache = null;
}
