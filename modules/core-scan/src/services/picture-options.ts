// THE ladder for a web picture, for every surface that wants one.
//
// Three surfaces search for pictures: the catalog tile filled on every scan
// (enrich-photo.ts), the entity picker (/image-options) and the scan inbox
// card's strip (/inbox/:id/photo-options). Each used to call the engine on
// its own, so every improvement landed on one and not the others: the second
// source, the shop-less retry and the honest "the engine is not answering"
// flag reached the picker while the inbox card still said `nothing found for
// "Apple Cider"` under a tile the library had just filled with two glasses
// of it (2026-09-07). One function now; the capability registry
// (scan:picture-options-pool) keeps the engine and the library private to it.
//
// The ladder:
//   1. a FRESH thing asks the photo library first, by its plain name. It
//      answers "roma tomatoes" with tomatoes and never a tin, and it does not
//      count our asks;
//   2. the engine, asked one at a time per process with a breath between
//      asks (a burst earns the address a wall that lasts hours);
//   3. the engine again for the plain thing when the shop-prefixed phrase
//      came back empty ("Lidl Chicken Breast" is empty, "Chicken Breast" is
//      not; the shop still ranks);
//   4. the library, for packaged goods too, when the engine refused;
//   5. `throttled: true` when the engine refused, so the caller says "busy"
//      and never "no picture of this product".

import {
  searchImages as engineSearch,
  rankImageOptions,
  withoutWords,
  DdgThrottledError,
  type DdgImageResult,
} from "./ddg-images.js";
import { mergeOptionPools, searchCommonsImages as librarySearch } from "./commons-images.js";
import { webSearchEnabled } from "./barcode-lookup.js";

export interface PictureOptionsAsk {
  /** The engine's phrase: name plus brand or shop plus any hints. */
  query: string;
  /** The plain name, for the library and for ranking what it answers.
   *  Defaults to the query with the brand words removed. */
  name?: string | null;
  /** The engine's phrase without the shop, for the second ask. Defaults to
   *  the query with the brand words removed. */
  plainQuery?: string | null;
  /** Ranks. Removed from the library ask and the second engine ask. */
  brand?: string | null;
  color?: string | null;
  /** A fresh category: the library goes first, and the ranker penalises tins. */
  fresh?: boolean;
  limit?: number;
}

export interface PictureOptions {
  items: DdgImageResult[];
  /** The engine refused or could not be reached. Distinct from an empty
   *  answer: it says nothing about the product. */
  throttled: boolean;
  /** Where the pictures came from, for the log line. */
  from: "library" | "engine" | "both" | "none";
}

/** The searches, injectable so the ladder can be tested without a network. */
export interface PictureSources {
  engine: (query: string, limit: number) => Promise<DdgImageResult[]>;
  library: (name: string, limit: number) => Promise<DdgImageResult[]>;
}

/** One engine ask at a time per process, with a breath between them. Serial
 *  alone was not enough: twelve back-to-back asks still earned a wall that
 *  lasted over an hour (2026-09-06). The library is not queued; it has a
 *  stated rate policy we are nowhere near. */
const SEARCH_SPACING_MS = 1500;
let searchChain: Promise<unknown> = Promise.resolve();
function withSearchSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = searchChain.then(fn, fn);
  searchChain = run.catch(() => undefined).then(() => new Promise<void>((r) => setTimeout(r, SEARCH_SPACING_MS)));
  return run;
}

/** The same switch the barcode web search honours (the self-host privacy
 *  master and COBBLR_SCAN_WEBSEARCH): off, and no surface reaches the web
 *  for a picture either. The picture ladder used to ignore it, so a
 *  workspace that had turned third-party lookups off still sent every
 *  item name to the engine, and the integration suite's API asked the real
 *  engine on every commit until a test timed out twice in a row because the
 *  engine was in a mood (2026-09-07). One switch, read at ask time so a
 *  test can flip it. */
const NONE: PictureSources = { engine: async () => [], library: async () => [] };
const REAL: PictureSources = { engine: (q, n) => withSearchSlot(() => engineSearch(q, n)), library: librarySearch };
function liveSources(): PictureSources {
  return webSearchEnabled() ? REAL : NONE;
}

export async function pictureOptions(ask: PictureOptionsAsk, sources: PictureSources = liveSources()): Promise<PictureOptions> {
  const { query, brand = null, color = null, fresh = false, limit = 12 } = ask;
  const name = ask.name?.trim() || withoutWords(query, brand);
  const plainQuery = ask.plainQuery?.trim() || withoutWords(query, brand);
  let throttled = false;
  const engine = (phrase: string) =>
    sources.engine(phrase, 24).catch((err: unknown) => {
      if (err instanceof DdgThrottledError) throttled = true;
      else console.warn(`[core-scan] picture search failed for ${JSON.stringify(phrase)}: ${(err as Error).message}`);
      return [] as DdgImageResult[];
    });
  const library = () => sources.library(name, 12).catch(() => [] as DdgImageResult[]);

  let fromLibrary: DdgImageResult[] = [];
  let fromEngine: DdgImageResult[] = [];
  if (fresh) {
    fromLibrary = await library();
    if (fromLibrary.length) console.log(`[core-scan] ${fromLibrary.length} library pictures for ${JSON.stringify(name)}`);
  }
  // A fresh thing the library answered for does not ask the engine at all:
  // the engine's best answer for it is a tin, and every ask costs standing.
  if (fromLibrary.length === 0) {
    fromEngine = await engine(query);
    if (fromEngine.length === 0 && !throttled && plainQuery !== query) fromEngine = await engine(plainQuery);
    if (fromEngine.length === 0 && throttled && !fresh) {
      fromLibrary = await library();
      if (fromLibrary.length) console.log(`[core-scan] engine refused; ${fromLibrary.length} library pictures for ${JSON.stringify(name)}`);
    }
  }
  const items = mergeOptionPools(
    rankImageOptions(fromEngine, brand, query, color, fresh),
    rankImageOptions(fromLibrary, brand, name, color, fresh),
    limit,
  );
  const from = fromEngine.length && fromLibrary.length ? "both" : fromEngine.length ? "engine" : fromLibrary.length ? "library" : "none";
  return { items, throttled, from };
}
