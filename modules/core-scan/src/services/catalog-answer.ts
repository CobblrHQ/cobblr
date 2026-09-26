// What the catalogs say a scanned code is, before any cache or web search:
// the barcode chain, and for a book's ISBN the book catalog as well. The scan
// (enrich.ts) takes its answer from here, and so does anything that asks "what
// would a scan of this code be named" without scanning it (the booth kit
// check). A check that called the barcode chain alone reported a miss for a
// book the scan itself names: the chain refuses a food filed under an ISBN
// (#3674), and the book catalog is asked only after that.
//
// Pure of writes: the caller decides what to cache.

import { answerAgreesWithCode, durableOutcome, lookupBarcode, type BarcodeHit, type BarcodeOutcome } from "./barcode-lookup.js";
import { classifyScanCode, resolveIsbn } from "./scan-router.js";
import { isBookSource } from "./catalog-replay.js";
import { gtinCases } from "./identifier-equals.js";
import { cleanListingTitle } from "./listing-title.js";

export interface CatalogAnswer {
  /** The barcode chain's own outcome, which is what gets cached as durable. */
  result: BarcodeOutcome;
  /** The answer a scan takes, or null. */
  hit: BarcodeHit | null;
  /** Throttled, refused a key, or could not be asked: unresolved, not absent. */
  rateLimited: boolean;
  lookupUnreachable: boolean;
  /** The hit came from the book catalog after the chain had none, so it is
   *  cached over the chain's miss rather than as the chain's answer. */
  bookAfterMiss: boolean;
}

/** How long the case codes, asked together, may add to a scan. A case that
 *  has not answered by then is no verdict: the item's own miss stands,
 *  uncached. Without a bound, an unknown code cost its own lookup plus each
 *  case's, and the barcode network may take its whole deadline on each. */
export const CASE_PROBE_BUDGET_MS = 2_000;

function withinBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export async function catalogAnswerForCode(code: string): Promise<CatalogAnswer> {
  const codeClass = classifyScanCode(code);
  let result = await lookupBarcode(code);
  // A loose item's own code can be unknown to every catalog while its case
  // is known: a skein's 877503009799 missed and its case 10877503009796 hit.
  // The case names the same product; its pack count is the seller's, never
  // the quantity on the table (the person's count or a label read sets it).
  if (result.outcome === "miss" && !result.refused && codeClass.type !== "isbn") {
    // Asked together: one after another, each waited on the catalog behind
    // the last, and a case code asked straight after the item's own found the
    // provider's slot taken.
    const cases = gtinCases(code);
    const probes = await Promise.all(cases.map((c) => withinBudget(lookupBarcode(c), CASE_PROBE_BUDGET_MS)));
    const at = probes.findIndex((p) => p?.outcome === "hit");
    const found = at >= 0 ? probes[at] : undefined;
    if (found?.outcome === "hit") {
      result = { outcome: "hit", hit: { ...found.hit, raw: { ...(found.hit.raw as object), case_code: cases[at] } } };
    } else if (probes.some((p) => p === null || durableOutcome(p) === null)) {
      // The item's own code was answered: nobody holds it. A case code that
      // could not be asked never turns that into "rate limited" (a busy
      // provider for a variant is not the code being throttled), but it does
      // keep the miss from being cached, since the case may still name it.
      result = { outcome: "miss", unconfirmed: true };
    }
  }
  let hit: BarcodeHit | null = result.outcome === "hit" ? result.hit : null;
  // A product catalog's answer the chain refused for an ISBN: not taken, but
  // named as what the book displaced when the book is found.
  const refused = result.outcome === "miss" ? result.refused : undefined;
  const rateLimited = result.outcome === "rate_limited" || result.outcome === "unavailable";
  const lookupUnreachable = result.outcome === "unavailable";
  let bookAfterMiss = false;
  if (codeClass.type === "isbn" && !rateLimited) {
    if (hit && !isBookSource(hit.source)) {
      // The chain's first answer for an ISBN can be a product catalog's stray
      // entry; the book's answer wins, and a non-book never stands (#3674).
      const book = await resolveIsbn(codeClass.code).catch(() => null);
      if (book) hit = { ...book, raw: { ...book.raw, displaced: { source: hit.source, title: hit.title } } };
      else if (!answerAgreesWithCode(code, hit)) hit = null;
    } else if (!hit) {
      // Not in any chain tier: the live book catalog, before web search.
      hit = await resolveIsbn(codeClass.code).catch(() => null);
      if (hit && refused) hit = { ...hit, raw: { ...hit.raw, displaced: { source: refused.source, title: refused.title } } };
      bookAfterMiss = !!hit;
    }
  }
  // A title learned from a resale listing ("Lot of 2 ... Dark Blue & White")
  // is cleaned to the one item it names.
  if (hit?.title) {
    const title = cleanListingTitle(hit.title);
    if (title !== hit.title) hit = { ...hit, title, raw: { ...(hit.raw as object), listing_title: hit.title } };
  }
  return { result, hit, rateLimited, lookupUnreachable, bookAfterMiss };
}

