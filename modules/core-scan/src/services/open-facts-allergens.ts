import { catalogRecording, catalogReplayDir, readCatalogCassette, writeCatalogCassette } from "./catalog-replay.js";

/** What an Open Facts record says a food contains (`allergens_tags`) and may
 *  carry traces of (`traces_tags`), as the plain words a person reads
 *  ("en:sulphur-dioxide-and-sulphites" is "sulphur dioxide and sulphites").
 *
 *  Only the catalog's own English taxonomy is read: a tag in another language
 *  is a contributor's free text, and translating or guessing at it is how an
 *  allergen would be invented. Nothing is inferred from the product's name. A
 *  record that lists none gives an empty list, which the caller leaves off
 *  entirely: "no allergens listed" is not a claim that there are none. */
export function openFactsWords(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const words: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string" || !/^en:[a-z0-9-]+$/.test(tag)) continue;
    const word = tag.slice(3).replace(/-/g, " ").trim();
    if (word && !words.includes(word)) words.push(word);
  }
  return words;
}

/** The `allergens` and `traces` a scan's suggested metadata carries, only
 *  where the catalog supplied them. */
export function allergenMeta(raw: unknown): { allergens?: string[]; traces?: string[] } {
  const p = (raw ?? {}) as Record<string, unknown>;
  const allergens = openFactsWords(p.allergens_tags);
  const traces = openFactsWords(p.traces_tags);
  return { ...(allergens.length ? { allergens } : {}), ...(traces.length ? { traces } : {}) };
}

/** A scan's word list as the text a record keeps ("milk, nuts"), or nothing
 *  when it has none. */
export function wordsOf(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  const words = list.filter((w): w is string => typeof w === "string" && w.trim().length > 0);
  return words.length ? words.join(", ") : undefined;
}

const OFF_TIMEOUT_MS = 10_000;
const OPEN_FACTS_SOURCES = new Set(["openfoodfacts", "openproductsfacts", "openbeautyfacts"]);

/** Whether a hit still has to ask Open Food Facts what it contains: a
 *  product another catalog named (upcitemdb, go-upc) carries no allergen
 *  fields, and Nutella or an Oreo scanned behind the box resolver read
 *  nothing (#7804). A hit already asked carries the tags, empty or not. */
export function asksOpenFoodFacts(hit: { source: string; raw: Record<string, unknown> }): boolean {
  return !OPEN_FACTS_SOURCES.has(hit.source) && !("allergens_tags" in hit.raw);
}

/** Open Food Facts' own allergen and trace tags for a barcode: empty when it
 *  has no such food or lists none, null when it could not be asked (a
 *  timeout, a 5xx, the network), which is not an answer and is not kept.
 *  With a replay dir it reads `<code>.food.json` and never the network. */
export async function openFoodFactsTags(code: string): Promise<{ allergens_tags: unknown[]; traces_tags: unknown[] } | null> {
  const tagsOf = (p: Record<string, unknown> | null) => ({
    allergens_tags: Array.isArray(p?.allergens_tags) ? p.allergens_tags : [],
    traces_tags: Array.isArray(p?.traces_tags) ? p.traces_tags : [],
  });
  if (catalogReplayDir() && !catalogRecording()) {
    const cassette = readCatalogCassette(code, "food");
    return tagsOf(cassette?.outcome === "hit" ? cassette.hit.raw : null);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OFF_TIMEOUT_MS);
  try {
    // EGRESS: vendor-fixed - Open Food Facts' own host, written here, already in the lookup chain
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,allergens_tags,traces_tags`, {
      headers: { "user-agent": "cobblr-core-scan/0.2", accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 404) return null;
    const body = (await res.json().catch(() => null)) as { status?: number; product?: Record<string, unknown> } | null;
    const product = body?.status === 1 && body.product ? body.product : null;
    const tags = tagsOf(product);
    writeCatalogCassette(code, product
      ? { outcome: "hit", hit: { source: "openfoodfacts", title: typeof product.product_name === "string" ? product.product_name : code, brand: null, model: null, description: null, category: null, image_url: null, raw: tags } }
      : { outcome: "miss" }, "food");
    return tags;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
