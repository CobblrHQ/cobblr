import { IDENTIFY_OUTPUT_SCHEMA, VERDICT_OUTPUT_SCHEMA } from "@cobblr/platform-contract/ai-output-schemas";
// Photo-only vision enrichment. A scan with a photo and NO barcode can't
// take the barcode fast path (there's no code to look up), so the photo
// itself is read by a vision model: image → {name, brand, category,
// entity_type, confidence}, producing the same draft-row shape the
// barcode path does. Runs DETACHED (the caller fires it without awaiting)
// so intake stays instant — "drop photos now, the queue sorts them later."
//
// All spend goes through core-ai (metered, provider-agnostic). No vision
// provider configured → the row degrades to a "fill in manually" draft;
// nothing auto-commits (every identified photo waits for a one-tap
// confirm in the triage queue).

import { nameCompletedFromLabel } from "./label-completes-name.js";
import { withContribution } from "@cobblr/platform-contract/field-contributions";
import { looksOfRow, picturesThatAgree, statedColoursOf } from "./picture-agrees.js";
import { applyHintWithoutAi } from "./hint-without-ai.js";
import { isStockPreviewUrl } from "./stock-preview.js";
import { rechoosePictureForColour, withholdContradictedPicture } from "./withhold-picture.js";
import { applyLabelFacts } from "./label-quantity.js";
import { applyLabelLot, applyLabelYearMade } from "./scan-frame-label.js";
import { labelFactsOf, yearMadeOf } from "./label-facts.js";
import { labelWordsOf, matchLabelWords } from "./label-words.js";
import type { Kysely } from "kysely";
import { seenCountOf, seenDistinctOf } from "./seen-count.js";
import { titleVariantsOf, type TitleVariants } from "@cobblr/platform-contract/display-identity";
import { PHOTO_READ_KEY, type PhotoRead } from "@cobblr/platform-contract/scan-evidence";
import { asPackaging, packagingFromProse, type Packaging } from "@cobblr/platform-contract/scan-tools";
import { platform } from "@cobblr/platform-contract";
import { isLineImageRef, storedLineImageId } from "@cobblr/platform-contract/email-line-images";
import { nameReadsAsProse, tidyTruncatedName } from "./item-name.js";
import { labelAgrees, nameFromLabelPhoto } from "./label-name.js";
import type { CoreScanDB } from "../db.js";
import { reportBarcodeCorrection, reportBarcodeReject, unitLotsOf, withoutLots } from "./barcode-corrections.js";
import { boxLabelPass } from "./box-label-pass.js";
import { identityMeta, mergeMeta, CATALOG_PICTURE_NOT_PERSONS } from "./metadata.js";
import {
  earnsMatchesYourPhoto,
  firstPass,
  mayActOnMismatch,
  needsEscalation,
  type CheckBasis,
} from "./crosscheck-policy.js";
import { evictBarcodeCaches, rememberLocalIdentity } from "./barcode-cache.js";
import { mediaSearchExtras, isFreshCategory, coverQuery, colorWordOnly, colorFromText } from "./ddg-images.js";
import { pictureOptions } from "./picture-options.js";
import { curatedImageUrl } from "./curated-images.js";
import { pickedImageUrl } from "./picked-images.js";
import { formFactorFromObservation } from "./form-factor.js";
import { sql } from "kysely";
import { cropRegion, detectSplitItems, parseProductRegion, type SplitBox } from "./image-ops.js";
import { LISTING_KEY, parseListing, type ListingRead } from "./listing-evidence.js";
import { seedHistory, pushStep, type CatalogSource } from "./catalog-history.js";
import { looksLikeReceiptPhoto } from "./receipt-photo.js";
import { ocrImageText } from "./ocr.js";
import { noReceiptShape, scoreReceiptShape, type ReceiptShape } from "./receipt-shape.js";
import { classifyAiFailure } from "@cobblr/platform-contract/ai-refusal";
import { providerReasonOf } from "@cobblr/platform-contract/provider-reason";
import { identifyFailureWords, type IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";
import { photoTooBlurry } from "./photo-blur.js";
import { toPhotoIdentity, receiptAsIdentity, HOSTED_QUEUED_WORDS, type HostedAnswer, type HostedQueued } from "./hosted-identify.js";
import { identifyWhyFor } from "./operator-services.js";

/** Re-fetch the catalog image to match a (corrected) name. The card prefers the
 *  downloaded `catalog_image_file_id` over `catalog_image_url`, so a rename left
 *  the OLD product's picture showing; here we set the best new external URL and
 *  clear the stale download so the right image renders. Detached-safe (no bearer:
 *  the external URL renders directly; a later backfill can download it). */
/** What a picture refresh did, so a caller that loops can stop when the
 *  engine says no: asking five more times in the same minute is the burst. */
export type CoverOutcome = "kept" | "stored" | "url" | "none" | "throttled";

const RETRY_AFTER_MS = 6 * 60_000;

/** The outcome AND when it was asked: the sweep re-asks an honestly-empty
 *  row no sooner than six hours after the last ask (pictures-sweeper.ts). */
async function stampImageStatus(db: Kysely<CoreScanDB>, itemId: string, status: "none" | "throttled"): Promise<void> {
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
        catalog_image_status: status,
        catalog_image_asked_at: new Date().toISOString(),
      })}::jsonb`,
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    .execute();
}

/** The shade an item is said to be, in words: "Dark Blue" out of a name or a
 *  colourway, or the bare colour when no shade word leads it. */
export function shadePhrase(text: string | null | undefined): string | null {
  const t = (text ?? "").toLowerCase();
  const colour = colorFromText(t);
  if (!colour) return null;
  const m = new RegExp(`\\b((?:dark|light|pale|deep|bright|royal|navy|sky|baby|electric|hot)\\s+)?${colour}\\b`).exec(t);
  return (m?.[0] ?? colour).trim();
}

/** Candidates whose own title names the item's exact shade first, the rest
 *  after in their ranked order. "Royal blue" and "Dark Blue" are both blue to
 *  the pixels; the words tell a dark blue skein which of them it is. */
export function shadeFirst(urls: readonly string[], titles: ReadonlyMap<string, string>, shade: string | null): string[] {
  if (!shade) return [...urls];
  const says = (u: string) => (titles.get(u) ?? "").toLowerCase().includes(shade);
  return [...urls.filter(says), ...urls.filter((u) => !says(u))];
}

/** The colour an item's fields say it is, in words a search can use. A
 *  colourway often leads with the maker's shade code ("J7 Dark Blue"); the
 *  code is dropped, and a hex swatch is never a word. */
export function colourWordOfFields(candidates: unknown): string | null {
  const cands = Array.isArray(candidates) ? (candidates as Array<{ fields?: Record<string, unknown> }>) : [];
  for (const c of cands) {
    for (const k of ["colorway", "colourway", "color", "colour"]) {
      const v = c.fields?.[k];
      if (typeof v !== "string") continue;
      const word = colorWordOnly(v.replace(/^\s*[A-Z]{0,2}\d+[A-Z]?\s+/i, "").trim());
      if (word) return word;
    }
  }
  return null;
}

/** The document checks put this row's name in doubt (check_fields). */
export function nameInDoubt(meta: unknown): boolean {
  const fields = (meta as { check_fields?: { fields?: unknown } } | null)?.check_fields?.fields;
  // The make and model are what a picture search reads with the name.
  return Array.isArray(fields) && (fields.includes("name") || fields.includes("make") || fields.includes("model"));
}

/** The photo the order email printed beside this line, and whether it is
 *  already the row's stored picture. Null when the line had none. */
export function orderLinePhoto(meta: unknown): { url: string; stored: boolean; fileId: string | null } | null {
  const m = (meta ?? {}) as { order_line_image?: unknown; store_line_image?: unknown; catalog_image_from?: unknown };
  // The email's own picture first; the variant's photo on the store's page
  // next (#5719); a search only when neither is there.
  const url =
    typeof m.order_line_image === "string" && isLineImageRef(m.order_line_image)
      ? m.order_line_image
      : typeof m.store_line_image === "string" && /^https?:\/\//i.test(m.store_line_image)
        ? m.store_line_image
        : null;
  return url ? { url, stored: m.catalog_image_from === url, fileId: storedLineImageId(url) } : null;
}

/** The email's own image part, already stored, as the row's picture (#5719):
 *  nothing to fetch, and never over a picture the person chose. */
async function useStoredLinePhoto(db: Kysely<CoreScanDB>, itemId: string, url: string, fileId: string): Promise<boolean> {
  const r = await db
    .updateTable("core_scan_inbox_items")
    .set({
      catalog_image_file_id: fileId,
      suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'catalog_image_status' - 'catalog_colour') || ${JSON.stringify({ catalog_image_from: url })}::jsonb`,
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    .where(CATALOG_PICTURE_NOT_PERSONS)
    .executeTakeFirst();
  return Number(r.numUpdatedRows ?? 0) > 0;
}

export async function refreshCatalogImageByName(
  orgId: string,
  itemId: string,
  name: string,
  brand?: string | null,
  /** The SHOP it was bought from, for a line off a receipt. Folded into the
   *  SEARCH phrase, not just the ranking: a receipt says "Croissant" and never
   *  says who made it, and "Lidl Croissant" comes back with the thing that was
   *  actually bought where "Croissant" comes back with a stock pastry. Verified
   *  on a real receipt's four lines. */
  soldBy?: string | null,
  /** The item's DECLARED category, once routing has decided it. Sharpens the
   *  search the way a colour does, and for a fresh category it keeps the
   *  ranking from choosing a tin. A receipt line has no category until it is
   *  matched, which is why the receipt path fetches its picture AFTER the
   *  match rather than at insert (see materializeReceiptLines). */
  category?: string | null,
  /** Set on the one unattended retry after a throttle, so it cannot chain. */
  retrying = false,
): Promise<CoverOutcome> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
  // A user who hand-picked a catalog image (photo-options strip / "use my photo")
  // OWNS it — a later re-identify (renamed item, hint correction) must NOT clobber
  // their choice. The catalog-image endpoint stamps `catalog_image_user_set`; honor
  // it here, the single choke point every re-gen routes through. (Revert clears it,
  // so the auto-refresh resumes.)
  const cur = await db
    .selectFrom("core_scan_inbox_items")
    .select(["suggested_metadata", "suggested_candidates"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if ((cur?.suggested_metadata as { catalog_image_user_set?: boolean } | null)?.catalog_image_user_set) return "kept";
  // The order email printed this line's own photo (#5350): it is the thing
  // that was bought, so it is the picture, ahead of every search. Every
  // re-search comes through here, so a rename or a sweep keeps it too. Only
  // a photo that cannot be fetched lets the search run.
  const printed = orderLinePhoto(cur?.suggested_metadata);
  if (printed) {
    if (printed.stored) return "kept";
    if (printed.fileId) {
      if (await useStoredLinePhoto(db, itemId, printed.url, printed.fileId)) return "stored";
    }
    const { downloadCatalogImage } = await import("./enrich.js");
    if (await downloadCatalogImage({ db, orgId, itemId }, printed.url, { asPrinted: true })) return "stored";
    console.warn(`[core-scan] the order email's photo for ${itemId} could not be fetched; searching instead`);
  }
  // A name the document checks found is not words ("C1yTe WATCU Ey oL 4") is
  // never searched for: the search answers it with whatever the garbage
  // resembles (wristwatches, #4571). It waits for the corrected name.
  if (nameInDoubt(cur?.suggested_metadata)) return "none";
  // Sharpen a weak title with author + media word (the same extras the
  // photo-options strip uses) so a book finds its cover, not generic images —
  // and with the observation's FORM FACTOR, so the default auto-fetch knows a
  // box is a box. The manual strip and the opt-in rank pass got that term in
  // the original fix while this path, the one every plain scan actually takes,
  // kept asking with the bare name and could still come home with a bottle.
  const { author, mediaWord } = mediaSearchExtras(cur?.suggested_candidates as Array<{ fields?: Record<string, unknown> }> | null);
  const form = formFactorFromObservation(
    (cur?.suggested_metadata as { photo_observations?: string } | null)?.photo_observations,
  );
  const fresh = isFreshCategory(category);
  // "fresh" goes into the ASK for a fresh category, because a bare noun plus a
  // shop name answers with the most photographed thing of that name in that
  // shop's catalogue, which for tomatoes is a tin. The category itself rides
  // along too, as the colour and the form factor already do.
  // The colour the item is, in words, from its colourway or colour field
  // ("J7 Dark Blue" says Dark Blue): a search for the product alone answers
  // with whatever shade was photographed most, and for a yarn that is rarely
  // the one on the table (#3729). coverQuery drops words the name already says.
  const colourWord = colourWordOfFields(cur?.suggested_candidates);
  const extra = [author, mediaWord, colourWord, form, fresh ? "fresh" : null, (category ?? "").trim() || null]
    .filter(Boolean)
    .join(" ") || null;
  const q = coverQuery(name, brand, soldBy, extra, fresh);
  // A hand-picked image WINS, before any searching. The curated manifest is an
  // operator-configured URL read live, so an entry can be added without a
  // deploy, and it existed only on the commit path (entity-image.ts): the scan
  // inbox, which is where every tile a person actually looks at is filled, went
  // straight to the search and could never be corrected except one row at a
  // time. That asymmetry is the bug; the manifest was always meant to be the
  // answer to "the search keeps getting this one wrong".
  //
  // FIRST rather than as a fallback, deliberately. The search almost never comes
  // back empty — it comes back with a recipe blog or a joke — so a rule that
  // only fired on nothing would almost never fire at all.
  const curated = await curatedImageUrl(q).catch(() => null);
  // Then the picture a PERSON already chose for this shop + product, from any
  // workspace. Below the operator's manifest, which is the vetted answer, and
  // above the search, which is the thing being corrected: a Lidl till slip says
  // "Baby Carrots" and the search kept coming home with a tin of peas and
  // carrots, every time, for everyone (2026-08-31). See picked-images.ts.
  const remembered = curated ? null : await pickedImageUrl(soldBy ?? brand ?? null, name);
  const chosen = curated ?? remembered;
  // The same ladder every strip climbs (services/picture-options.ts): the
  // library first for a fresh thing, the engine one ask at a time, the plain
  // phrase when the shop-prefixed one is empty, the library again when the
  // engine refuses. Ranked on the way out.
  let ranked: string[] = [];
  let rankedTitles = new Map<string, string>();
  if (!chosen) {
    const found = await pictureOptions({
      query: q,
      plainQuery: coverQuery(name, brand, null, extra, fresh),
      name,
      brand: brand || soldBy,
      fresh,
      limit: 24,
    });
    if (found.items.length === 0 && found.throttled) {
      // The engine said no to US, not to the query. Say "busy" on the row,
      // not "none" - and try once more later, unattended, because a person
      // filing a receipt should not have to come back and press retry
      // twelve times for a wall that lifts on its own.
      console.warn(
        `[core-scan] picture search throttled for ${JSON.stringify(q)}; ${
          retrying ? "the sweep will try again later" : `retrying in ${RETRY_AFTER_MS / 60000}m`
        }`,
      );
      await stampImageStatus(db, itemId, "throttled");
      if (!retrying) {
        const t = setTimeout(() => {
          void refreshCatalogImageByName(orgId, itemId, name, brand, soldBy, category, true).catch(() => undefined);
        }, RETRY_AFTER_MS);
        if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
      }
      return "throttled";
    }
    if (found.items.length === 0) console.warn(`[core-scan] no pictures found for ${JSON.stringify(q)}`);
    // Never a picture that contradicts what the item says it is: a white
    // plastic kettle is not given a stainless one (picture-agrees.ts, #3584).
    // The ones that agree go first; if none is left the row keeps the
    // person's own photo and the choice stays open.
    const agreeing = picturesThatAgree(looksOfRow(cur ?? {}, name), found.items);
    if (found.items.length && !agreeing.length) console.warn(`[core-scan] every picture for ${JSON.stringify(q)} contradicts the item; keeping its own photo`);
    ranked = agreeing.map((r) => r.url).filter((u): u is string => !!u);
    rankedTitles = new Map(agreeing.map((r) => [r.url, r.title ?? ""]));
  }
  // Try to DOWNLOAD the top candidates into core-files, falling through until one
  // stores. Storing just the top RAW url (as this did) left many tiles empty: a
  // product-page image often hotlink-blocks or 404s in the browser, and there was
  // no fallback to the next result (reported 2026-07-24). downloadCatalogImage handles
  // SSRF-guard + retries + size limits and stamps catalog_image_file_id. Dynamic
  // import because enrich.ts imports THIS module — a static import would cycle.
  // A remembered pick can predate the stock-preview rule (#3804); it is
  // refused here like any other, so the raw-address fallback below cannot
  // put an agency's watermark on the row either.
  const candidates = (chosen ? [chosen] : ranked.slice(0, 4)).filter((u) => !isStockPreviewUrl(u));
  if (!candidates.length) {
    // Say so on the row. An empty tile used to be indistinguishable from
    // "still looking". The card reads this to offer a retry instead of nothing.
    await stampImageStatus(db, itemId, "none");
    return "none";
  }
  const { downloadCatalogImage } = await import("./enrich.js");
  // A picture that SHOWS the colour the item states wins over one that only
  // does not contradict it: a dark blue skein gets a blue picture, not the
  // first one whose pixels happened to be neutral (#3729). The first pass
  // measures more candidates than the fallback keeps, since most are refused.
  const stated = statedColoursOf(looksOfRow(cur ?? {}, name));
  if (!chosen && stated.size) {
    const shade = shadePhrase(colourWord ?? name);
    for (const url of shadeFirst(ranked.slice(0, 8), rankedTitles, shade)) {
      if (await downloadCatalogImage({ db, orgId, itemId }, url, { mustShow: true })) return "stored";
    }
  }
  for (const url of candidates) {
    if (await downloadCatalogImage({ db, orgId, itemId }, url)) return "stored"; // stored → done
  }
  // None downloaded — keep the best raw url as a last resort (renders if it isn't
  // hotlink-blocked), never regressing to no image at all. A picture, even a
  // raw one, ends the busy/none story - see the same clearing in enrich.ts.
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      catalog_image_url: candidates[0],
      catalog_image_file_id: null,
      suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) - 'catalog_image_status'`,
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    // The check at the top of this function read the row before the search
    // went out; a pick made since is the person's (metadata.ts).
    .where(CATALOG_PICTURE_NOT_PERSONS)
    .execute();
  return "url";
}

/** Multipack detection (scan-parity Epic D): read "2 Pack" / "12 ct" /
 *  "6-pack" off a resolved title. Returns the unit count (2–500) or null.
 *  Guards against sizes-that-aren't-counts ("14.4 oz", "100 ft"). Lives here
 *  (not enrich.ts) because enrich.ts imports this module — same direction. */
export function parsePackSize(title: string | null | undefined): number | null {
  const t = (title ?? "").toLowerCase();
  if (!t) return null;
  const m = t.match(/(?:^|[\s(])(\d{1,3})\s*-?\s*(?:pack|pk|ct|count|pcs|pieces)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 2 && n <= 500 ? n : null;
}

interface PhotoEnrichContext {
  db: Kysely<CoreScanDB>;
  /** Org UUID — for the metered core-ai vision call. */
  orgId: string;
  /** Inbox row id. */
  itemId: string;
  /** The scanned photo's core-files id. */
  imageFileId: string;
  /** The user who triggered the scan/re-run. Threaded into the AI call so a
   *  personal AI connection resolves via the OWNER's route ('own' path), not
   *  only the 'workspace-default' share path — this is why an unidentified photo
   *  failed instantly on a hosted workspace whose AI is a personal connection:
   *  the detached enrich had no caller. */
  userId?: string | null;
  /** A user-triggered re-run → bypass the AI cache so the identify reflects the
   *  current prompt, not a stale result cached for this image. */
  force?: boolean;
  /** See IdentifyImageOpts.visitorIp. */
  visitorIp?: string | null;
  /** The user's research hint (a short text correction) — folded into the vision
   *  identify as an AUTHORITATIVE correction that overrides the visual read, so
   *  a hint naming a DIFFERENT item than the obvious one re-identifies to it. */
  hint?: string;
  /** Every correction the user has given this item, oldest first (standingHints).
   *  The prompt weighs later over earlier; `hint` is the newest. */
  hints?: string[];
  /** The person answered YES to the first look: identification is settled and
   *  the read elaborates on this name (see services/glance.ts). */
  confirmedName?: string;
  /** The person answered NO: these guesses are off the table. */
  rejectedNames?: string[];
  /** A finished queued identify's answer (see IdentifyImageOpts.hostedAnswer). */
  hostedAnswer?: HostedAnswer;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** What a vision identify produces from one image. */
export interface PhotoIdentity {
  name: string;
  brand: string | null;
  category: string | null;
  /** The item's colour in plain English, when it has one obvious colour. Stored
   *  as a METADATA fact, so it exists even when the destination table declares
   *  no colour field — which is the usual case, and why a colour used to be
   *  unknowable (reported 2026-07-30). */
  color: string | null;
  entityType: "asset" | "part" | null;
  /** A known series/franchise this titled work belongs to (Harry Potter,
   *  Little House on the Prairie), or null. Used to group + tag siblings. */
  series: string | null;
  /** The author, artist or maker AS PRINTED on the cover or label, when
   *  legible; never completed from knowledge. Evidence, not inference
   *  (scan-evidence.ts). */
  creator?: string | null;
  /** A titled work's title as printed, its translation and its
   *  transliteration, kept apart (the contract's TitleVariants, #3061); null
   *  for anything that is not a titled work in another language. Only what
   *  the model actually gave: a missing part stays missing. */
  title_variants?: TitleVariants | null;
  confidence: number;
  /** A UPC/EAN the vision model read off the package (digits only), or null.
   *  OCR'd — lower trust than a hardware scan, so it's captured as AI-read. */
  barcode: string | null;
  /** A serial number / service tag read verbatim off the item's label, or null.
   *  A universal identifier — routed to the destination table's native
   *  serial_number field on commit. OCR'd, so read-only-if-legible + never
   *  guessed (the prompt forbids completing a partial one). */
  serial_number: string | null;
  /** The year this unit was made as printed (a wine's vintage), four digits,
   *  or null. Per unit: a row fact filed by role, never sent as a product
   *  fact (barcode-corrections.ts unitLotsOf). */
  year_made?: string | null;
  /** Factual prose on what's physically in frame (packaging state, "sealed
   *  10-pack, label says QTY 10"). The matchmaker's corroboration — it OUTRANKS
   *  listing-derived counts and is what catches the unit-barcode-on-a-multipack
   *  trap. Empty string when the model didn't say (an older cached reply). */
  observations: string;
  /** When the upload was a SCREENSHOT of a listing, where the item's own
   *  photograph sits inside it — so it can be cropped out and used as the
   *  catalog image instead of a stock photo of some other unit. Null for an
   *  ordinary photo, which is the common case. */
  product_photo_box: { x: number; y: number; w: number; h: number } | null;
  /** What a listing screenshot printed about the sale (listing-evidence.ts):
   *  purchase evidence, like a receipt. Null for anything else, and on a
   *  reply from before the prompt asked. */
  listing?: ListingRead | null;
  /** How many DISTINCT things are pictured. Several units of the SAME product is
   *  a quantity, not a split (a sealed 10-pack of screws is ONE thing) — only
   *  genuinely different items count. 1 for the overwhelmingly common case. */
  distinct: number;
  /** Those things, named — present when `distinct` >= 2, so the inbox can offer
   *  "split into individuals" and LIST them without a second vision call. */
  individuals: Individual[];
  /** The model's own answer to "is this a receipt?", asked as a field so the
   *  verdict is data. Absent on a reply from before the prompt asked (an
   *  older cached reply, the hosted service), when the prose rules decide. */
  is_receipt?: "yes" | "no" | "unsure";
  /** What the pass saw of the packaging (#3006): the key when the reply
   *  carries it, else read off the observations' prose. */
  packaging?: Packaging;
}

export interface Individual {
  name: string;
  brand: string | null;
  qty: number;
}

/**
 * The distinct-count + named-list normalizer, shared by BOTH vision parsers
 * (identify and observe) so the two can never disagree about what "2 different
 * things" means. Tolerant: bad entries drop out rather than failing the parse.
 */
export function normalizeIndividuals(
  rawItems: unknown,
  claimedDistinct: unknown,
): { distinct: number; individuals: Individual[] } {
  const all = Array.isArray(rawItems) ? rawItems : [];
  // What sits behind the subject or half out of frame is not a thing to
  // split off: one ball of yarn with another skein at the edge of the shot
  // was offered as "2 different items" (#3884).
  const items = all.filter((it) => (it as { background?: unknown } | null)?.background !== true);
  const droppedBackground = items.length < all.length;
  const individuals = items
    .map((it): Individual | null => {
      const i = (it ?? {}) as { name?: unknown; brand?: unknown; qty?: unknown };
      const name = typeof i.name === "string" ? i.name.trim() : "";
      if (!name) return null;
      return {
        name: name.slice(0, 200),
        brand: typeof i.brand === "string" && i.brand.trim() ? i.brand.trim().slice(0, 120) : null,
        qty: seenCountOf(i.qty),
      };
    })
    .filter((x): x is Individual => x !== null);

  // Trust the LIST over the count. A model that claims 3 but names 2 has named
  // what it actually saw, and the offer must never promise an item it can't
  // produce. A count with NO names is still honest ("2 items — split?"); the
  // names then come from the segmentation pass the user opted into.
  // A count that included what the list now leaves out is no longer the count.
  const distinct = individuals.length >= 2 ? individuals.length : droppedBackground ? 1 : seenDistinctOf(claimedDistinct);
  return { distinct, individuals: distinct >= 2 ? individuals : droppedBackground ? [] : individuals };
}

/**
 * The pure image → identity step: one metered `identify-image` call + tolerant
 * parse. No DB, no file IO — bytes in (base64), identity out. Returns null when
 * there's no vision provider, the call/parse fails, or the model can't name a
 * single item. Shared by `enrichPhotoItem` (which then writes the row) and the
 * super-admin eval seam (docs/operations/ai-prompt-eval-harness.md, P3).
 */
/** Named, not positional, on purpose. This took eight positional parameters, and
 *  four of them were optional and adjacent, so deleting one silently shifted
 *  every argument after it into the wrong slot at every call site. That happened
 *  while removing the replay flag: `hints` landed in the slot the deleted
 *  parameter had occupied, and only a type mismatch (string[] vs boolean) turned
 *  it into a compile error instead of a wrong prompt. Two same-typed neighbours
 *  and it would have shipped. A named bag makes the mistake unexpressible. */
export interface IdentifyImageOpts {
  orgId: string;
  imageB64: string;
  mediaType: string;
  sourceId?: string;
  userId?: string | null;
  bypassCache?: boolean;
  hint?: string;
  /** Every correction the user has given this item, oldest first. The prompt
   *  shows them all and weighs later over earlier; `hint` stays the newest for
   *  callers that only carry one. */
  hints?: string[];
  /** The person answered YES to the first look: identification is settled and
   *  the read elaborates on this name (see services/glance.ts). */
  confirmedName?: string;
  /** The person answered NO: these guesses are off the table. */
  rejectedNames?: string[];
  /** The workspace's existing category vocabulary, so the identify reuses a
   *  label instead of inventing a synonym of one. */
  knownCategories?: string[];
  /** The visitor driving this scan, when a request started it — forwarded to
   *  the hosted identify so its per-person daily tier works. Detached work
   *  with no visitor omits it. */
  visitorIp?: string | null;
  /** The hosted service's answer to this photo, already in hand: a queued
   *  identify that finished (hosted-identify-job.ts). Used exactly as if the
   *  service had answered at once, and nothing is asked again. */
  hostedAnswer?: HostedAnswer;
}

/** What an identify produced: an identity, or WHY there is none. The reason
 *  is a code (the router's refusal, the provider's own reason, an answer that
 *  could not be read, or a model that saw no single item), so the note under
 *  the photo can say the one true thing instead of listing every possibility. */
export type IdentifyOutcome =
  | { identity: PhotoIdentity; failure?: undefined; answeredBy?: AnsweredBy; hostedJob?: undefined }
  | { identity: null; failure: IdentifyFailure; answeredBy?: undefined; hostedJob?: HostedQueued };

/** Which AI answered, when it was not the first one asked: the card says
 *  "Answered by X; Y was busy" (#3819). */
export interface AnsweredBy {
  /** The connection's own name (the router's provider_label). */
  label: string;
  model?: string;
  after: Array<{ label: string; model?: string; reason: string }>;
}

/** The AI named nothing: say whether the photo was out of focus, which the
 *  pixels can tell, so the row asks for it again instead (#8796). */
async function nothingNamed(imageB64: string, reason: string): Promise<IdentifyFailure> {
  return (await photoTooBlurry(Buffer.from(imageB64, "base64"))) ? { code: "blurry", reason: `${reason}; the photo is out of focus` } : { code: "no_item", reason };
}

/** The identity alone, for callers that only want a name (the barcode
 *  path's last resort, the eval harness). */
export async function identifyImage(opts: IdentifyImageOpts): Promise<PhotoIdentity | null> {
  return (await identifyPhoto(opts)).identity;
}

/** A read whose "name" described the photo is named from the photo's label
 *  instead (#6100): the label's largest product-like line, read with no
 *  model. Null, so the row asks to be named, when the read was not a
 *  description or no line on the label stands out. */
async function namedFromLabel(
  readName: unknown,
  imageB64: string,
  rebuild: (name: string) => PhotoIdentity | null,
): Promise<PhotoIdentity | null> {
  if (typeof readName !== "string" || !nameReadsAsProse(readName)) return null;
  const label = await nameFromLabelPhoto(Buffer.from(imageB64, "base64")).catch(() => null);
  // The read's own description is the evidence: a label line sharing no
  // word with it is something the OCR found, not what the read saw.
  return label && labelAgrees(label, [readName]) ? rebuild(label) : null;
}

export async function identifyPhoto({
  orgId,
  imageB64,
  mediaType,
  sourceId,
  userId,
  bypassCache,
  hint,
  hints,
  confirmedName,
  rejectedNames,
  knownCategories,
  visitorIp,
  hostedAnswer,
}: IdentifyImageOpts): Promise<IdentifyOutcome> {
  // Hosted identify first, when this deployment has it (the try sandbox, or a
  // keyed self-host). Null falls through to the tenant path unchanged, so the
  // hosted service being down is never worse than never having had it.
  let hostedDegraded: IdentifyFailure["hosted"];
  // A photo the hosted service accepted and will answer later (every engine
  // it has was busy or out, barcode-intelligence #43). The tenant path is
  // still asked below; if it cannot answer either, the row waits for this job
  // instead of reading as unidentified.
  let hostedJob: HostedQueued | undefined;
  // identifyWhyFor → hostedIdentifyWhy asks hostedIdentifyReach first, the question
  // /ai-status asks too: no second, looser "is it on" check here.
  {
    const why = hostedAnswer ? { answer: hostedAnswer } : await identifyWhyFor({ orgId, imageB64, visitorIp, userId, mimeType: mediaType });
    const hosted = why.answer;
    if ("degraded" in why && why.degraded && why.degraded !== "off") hostedDegraded = why.degraded;
    if ("queued" in why && why.queued) hostedJob = why.queued;
    if (hosted?.kind === "item" && hosted.item) {
      const mapped = toPhotoIdentity(hosted.item) ?? (await namedFromLabel(hosted.item.name, imageB64, (name) => toPhotoIdentity({ ...hosted.item!, name })));
      if (mapped) return { identity: mapped };
    }
    if (hosted?.kind === "receipt") return { identity: receiptAsIdentity() };
    if (hosted?.kind === "person" || hosted?.kind === "unidentifiable") {
      return { identity: null, failure: await nothingNamed(imageB64, `hosted identify: ${hosted.kind}`) };
    }
  }
  let parsed: Record<string, unknown> | null = null;
  let raw = "";
  let answeredBy: AnsweredBy | undefined;
  try {
    const r = await platform().ai.invoke({
      orgId,
      capability: "identify-image",
      input: { output_schema: IDENTIFY_OUTPUT_SCHEMA,
        image_b64: imageB64,
        image_media_type: mediaType,
        ...(hint ? { user_hint: hint } : {}),
        ...(hints && hints.length > 1 ? { user_hints: hints } : {}),
        ...(confirmedName ? { confirmed_name: confirmedName } : {}),
        ...(rejectedNames && rejectedNames.length ? { rejected_names: rejectedNames } : {}),
        ...(knownCategories && knownCategories.length ? { known_categories: knownCategories } : {}),
      },
      source: { kind: "core-scan:photo", id: sourceId ?? "eval" },
      // Route through the caller's own AI connection (the 'own' path), not only
      // the workspace-default share path. Without it a detached photo enrich on a
      // personal-connection workspace resolved no provider → instant fail.
      userId: userId ?? undefined,
      // A re-run ("re-ask everything") forces a fresh call so it reflects the
      // CURRENT identify prompt, not a result cached under an older one (keyed by
      // image, not prompt — a prompt fix wouldn't otherwise reach a cached image).
      bypass_cache: bypassCache,
    });
    raw = r.text;
    if (r.answered_after?.length) answeredBy = { label: r.provider_label ?? r.provider_id, model: r.model, after: r.answered_after.map((a) => ({ label: a.label, model: a.model, reason: a.reason })) };
  } catch (err) {
    // The router's refusal or the provider's failure, as the code it carries
    // (ai-refusal.ts, provider-reason.ts): the note under the photo reads
    // this, and so does the eval. Logged too, so a vision failure is
    // diagnosable from the server side.
    const ai = classifyAiFailure(err, { hadUser: !!userId });
    const ai_reason = providerReasonOf(err) ?? undefined;
    const reason = (err as Error)?.message ?? String(err);
    const ai_provider = (err as { providerLabel?: string } | null)?.providerLabel;
    const model = (err as { model?: string } | null)?.model;
    console.error(`[core-scan] identify failed (${ai}${ai_reason ? `/${ai_reason}` : ""}${model ? `, model ${model}` : ""}):`, reason);
    return { identity: null, failure: { code: "ai_unavailable", ai, ...(ai_reason ? { ai_reason } : {}), ...(ai_provider ? { ai_provider } : {}), ...(hostedDegraded ? { hosted: hostedDegraded } : {}), reason }, ...(hostedJob ? { hostedJob } : {}) };
  }
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : raw);
  } catch (err) {
    console.error("[core-scan] identify reply was not JSON:", (err as Error)?.message ?? err);
    return { identity: null, failure: { code: "no_answer", ai: "no-answer", reason: "reply was not JSON" }, ...(hostedJob ? { hostedJob } : {}) };
  }
  const identity = parseIdentityReply(parsed) ?? (await namedFromLabel(parsed?.name, imageB64, (name) => parseIdentityReply({ ...parsed, name })));
  if (!identity) return { identity: null, failure: await nothingNamed(imageB64, "no name in the reply"), ...(hostedJob ? { hostedJob } : {}) };
  return { identity, ...(answeredBy ? { answeredBy } : {}) };
}

/**
 * Deterministic fallback for a serial the model READ but didn't structure.
 * The identify prompt asks for `serial_number`, but the vision/matchmaker model
 * sometimes only cites the serial in its prose ("Serial 023GHCLF300971D is
 * confirmed on the label") and leaves the field null. This pulls a LABELLED
 * serial out of any such text so it still reaches the item's native serial
 * field on commit. Conservative on purpose: it only fires on an explicit
 * label (Serial / S/N / Service tag) AND requires a digit, so English words
 * like "serial field" / "serial number" don't get mistaken for a value.
 */
export function extractSerial(text: string): string | null {
  if (!text) return null;
  const m = text.match(
    /\b(?:serial(?:\s*(?:number|no\.?|#))?|s\/?n|service\s*tag)\b\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,40})/i,
  );
  if (!m) return null;
  const s = (m[1] ?? "").replace(/[.,;:)\]]+$/, "").trim();
  // Serials carry digits — this rejects prose like "serial field"/"serial number".
  return s.length >= 5 && /\d/.test(s) ? s : null;
}

/**
 * Pure, tolerant parse of the identify-image model reply into a `PhotoIdentity`.
 * The model mostly returns the asked-for {name,…} shape but sometimes a richer
 * one ({product_line, product_name, type, manufacturer, …}); pull a usable name
 * from either rather than failing the whole identify (which once surfaced as a
 * bogus "no vision provider" note — the vision worked). Exported so the parse is
 * unit-tested without a live vision call (mirrors matchmaker's parse split).
 * Returns null when no name is recoverable.
 */
export function parseIdentityReply(parsed: Record<string, unknown> | null): PhotoIdentity | null {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const p = (parsed ?? {}) as Record<string, unknown>;
  const isReceiptRaw = typeof p.is_receipt === "boolean" ? String(p.is_receipt) : str(p.is_receipt).toLowerCase();
  const is_receipt: PhotoIdentity["is_receipt"] =
    isReceiptRaw === "yes" || isReceiptRaw === "true" ? "yes" : isReceiptRaw === "no" || isReceiptRaw === "false" ? "no" : isReceiptRaw === "unsure" ? "unsure" : undefined;
  const name = tidyTruncatedName(
    str(p.name) ||
    [str(p.product_line), str(p.product_name)].filter(Boolean).join(" ").trim() ||
    str(p.product_name) ||
    str(p.title) ||
    "",
  );
  // A receipt has no name, and the prompt says to leave it empty. That used
  // to read as "nothing identifiable" and the photo sat unnamed under a
  // generic note (#2916); it is the receipt verdict, with the model's own
  // observations kept for the row.
  if (!name && is_receipt === "yes") {
    return { ...receiptAsIdentity(), observations: str(p.observations).slice(0, 1500) || receiptAsIdentity().observations, is_receipt };
  }
  if (!name || nameReadsAsProse(name)) return null;
  const rawType = str(p.entity_type) || str(p.type);
  const et: "asset" | "part" | null = rawType === "asset" || rawType === "part" ? rawType : null;
  return {
    name,
    brand: str(p.brand) || str(p.manufacturer).split(",")[0]?.trim() || null,
    category: str(p.category) || str(p.product_line) || null,
    color: str(p.color) || null,
    entityType: et,
    series: str(p.series) || str(p.franchise) || null,
    title_variants: titleVariantsOf({ title_variants: p.title_variants }),
    creator: str(p.creator),
    // A richer-shape reply with no confidence field WAS confident enough to
    // describe the item — don't read that as a 0.5 maybe.
    confidence: clamp01(typeof p.confidence === "number" ? p.confidence : str(p.name) ? 0.5 : 0.75),
    // A barcode the model read off the package (various keys it might use).
    barcode: (() => {
      const b = (str(p.barcode) || str(p.upc) || str(p.ean) || str(p.barcode_number)).replace(/\D/g, "");
      return /^[0-9]{8,14}$/.test(b) ? b : null;
    })(),
    // A serial / service tag read off the label (various keys it might use).
    // Kept verbatim (serials are alphanumeric with dashes) — just trimmed and
    // length-capped; empty/placeholder reads collapse to null.
    serial_number: (() => {
      const s = (str(p.serial_number) || str(p.serial) || str(p.service_tag) || str(p.serialNumber)).slice(0, 80);
      return s && !/^(n\/?a|none|unknown)$/i.test(s) ? s : null;
    })(),
    year_made: yearMadeOf(p.year_made ?? p.vintage),
    // The same read also tells us what's in frame and how many DIFFERENT things
    // there are. An older reply cached before the prompt asked for these simply
    // has neither: observations "" and distinct 1 — i.e. exactly the pre-change
    // behavior, no split offer. Never a reason to fail the identify.
    observations: str(p.observations).slice(0, 1500),
    // Validated, not trusted: a model that finds no photograph sometimes returns
    // a sliver or a near-full-frame box instead of the null it was asked for.
    product_photo_box: parseProductRegion({ box: p.product_photo_box }),
    listing: parseListing((p as { listing?: unknown }).listing),
    ...normalizeIndividuals(p.items, p.distinct_items),
    ...(is_receipt ? { is_receipt } : {}),
    packaging: asPackaging((p as { packaging?: unknown }).packaging) ?? packagingFromProse(str(p.observations)),
  };
}

/**
 * What a fresh identity writes into `suggested_metadata`, as a pure decision:
 * the keys to SET, and the identify-owned keys to KEEP rather than clear.
 *
 * The caller feeds this to `identityMeta()`, which drops every identify-owned key
 * (minus `keep`) and overlays `set` — DB-side, in one statement, against the LIVE
 * row. Nothing is read-modify-written, so a key another pass commits while the
 * vision call is in flight (the user tapping "Reviewed" during the tens of seconds
 * a detached identify runs) cannot be rolled back by this write.
 *
 * This used to build the whole object in JS and hand-copy two keys forward, which
 * destroyed every other key on each re-run: `photo_distinct` (so a re-run ERASED
 * the split offer, then paid a second vision call to rediscover it — the "it
 * didn't offer to separate, then it did" report) and `keep_grouped` (so a re-run
 * threw away the user's ANSWER and asked again).
 */
export function identityOverlay(
  identity: PhotoIdentity,
  opts: {
    imageFileId: string;
    captureBarcode: string | null;
    hint?: string | undefined;
    /** `photo_observed_for` currently on the row — which image the stored
     *  observation describes, or null/undefined if there isn't one. */
    priorObservedFor?: string | null | undefined;
  },
): { set: Record<string, unknown>; keep: string[] } {
  const set: Record<string, unknown> = {
    source: "vision",
    category: identity.category,
    ...(identity.color ? { color: identity.color } : {}),
    entity_type: identity.entityType,
  };
  if (identity.series) set.series = identity.series;
  if (identity.title_variants) set.title_variants = identity.title_variants;
  // What this picture shows as printed, kept apart from what the pass
  // inferred: the route's guesses are checked against it (#3070).
  const read = photoReadFor(opts.imageFileId, { creator: identity.creator ?? null, brand: identity.brand, title: identity.title_variants?.original?.title ?? null });
  if (read) set[PHOTO_READ_KEY] = read;
  // A serial/service tag read off the label → carried to the destination table's
  // native serial_number field on commit (see inbox.ts commit).
  if (identity.serial_number) set.serial_number = identity.serial_number;
  // The year printed on this unit (a vintage) → the destination's year-made
  // field on commit (lot-field.ts), like the lot a label read leaves.
  if (identity.year_made) set.year_made = identity.year_made;
  if (opts.captureBarcode) set.barcode_source = "ai-photo";
  const pack = parsePackSize(identity.name);
  if (pack) set.pack_size = pack;
  // Keep the correction visible to the matchmaker as an authoritative hint.
  if (opts.hint) set.user_hint = opts.hint;

  const keep: string[] = [];
  // The pass's own verdicts as data, for the inbox's tool rule (#3006): is
  // this a receipt, and what did it see of the packaging.
  if (identity.is_receipt) set.photo_is_receipt = identity.is_receipt;
  if (identity.packaging) set.packaging = identity.packaging;
  if (identity.listing) set[LISTING_KEY] = identity.listing;
  if (identity.observations) {
    // The observation rides the SAME vision read as the name, so the split offer
    // lands in this one write instead of trailing a second call by seconds.
    set.photo_observations = identity.observations;
    set.photo_distinct = identity.distinct;
    set.photo_individuals = identity.individuals;
    set.photo_observed_for = opts.imageFileId;
  } else if (opts.priorObservedFor && opts.priorObservedFor === opts.imageFileId) {
    // A reply cached before the prompt asked for an observation carries none. The
    // previous run's read of THIS SAME photo is still true, so keep it rather than
    // clearing it and paying to rediscover the same answer. (A retake changes the
    // image id, so a stale observation about a photo that no longer exists is
    // NOT kept — it falls through and gets cleared.)
    keep.push("photo_observations", "photo_distinct", "photo_individuals", "photo_observed_for");
  }
  return { set, keep };
}

/** The printed read of ONE picture, as the evidence rule reads it
 *  (scan-evidence.ts PHOTO_READ_KEY): nothing stored when nothing legible
 *  was read, and never a read of another picture than the row's own. */
export function photoReadFor(imageFileId: string, printed: { creator?: string | null; brand?: string | null; title?: string | null } | null | undefined): PhotoRead | null {
  if (!printed || typeof printed !== "object") return null;
  const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null);
  const read: PhotoRead = { for: imageFileId, creator: clean(printed.creator), brand: clean(printed.brand), title: clean(printed.title) };
  return read.creator || read.brand || read.title ? read : null;
}

async function keepPhotoRead(orgId: string, itemId: string, imageFileId: string, printed: { creator?: string | null; brand?: string | null; title?: string | null } | null | undefined): Promise<void> {
  const read = photoReadFor(imageFileId, printed);
  if (!read) return;
  try {
    const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ [PHOTO_READ_KEY]: read }, []) as never, updated_at: new Date() })
      .where("id", "=", itemId)
      .execute();
  } catch (e) {
    console.warn(`[core-scan] ${itemId}: could not keep the photo's printed read:`, (e as Error).message);
  }
}

async function patchNote(ctx: PhotoEnrichContext, note: string): Promise<void> {
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({ ai_notes: note, ai_suggested_at: new Date(), updated_at: new Date() })
    .where("id", "=", ctx.itemId)
    .execute();
}

/**
 * Factual vision OBSERVATIONS of the scanned photo — for corroborating the
 * barcode/catalog data in the matchmaker (is this ONE unit or a sealed
 * multipack? what does the label actually say?). Distinct from
 * `identifyImage` (which names an unknown item): this describes what is
 * physically present, 2-3 plain sentences, no speculation. Returns null on
 * no provider / no bytes / failure — corroboration is best-effort.
 */
export interface PhotoObservation {
  /** The factual prose. Byte-for-byte the same job it always did — the
   *  matchmaker consumes this as corroboration and is unaffected by the rest. */
  text: string;
  /** How many DISTINCT things are pictured. Several units of the SAME product is
   *  a quantity, not a split (a sealed 10-pack of screws is ONE thing) — only
   *  genuinely different items count here. 1 for the overwhelmingly common case. */
  distinct: number;
  /** Named, when `distinct` >= 2 — a penguin humidifier AND a frog humidifier.
   *  This is what lets the inbox offer "split into individuals" with the actual
   *  list, without paying for a second vision call to find out what they are. */
  individuals: Array<{ name: string; brand: string | null; qty: number }>;
  /** What the pass saw of the packaging, as the one key the inbox's tool rule
   *  reads (#3006); read off the prose when the reply predates the key. */
  packaging: Packaging;
}

export async function observeScanPhoto(
  orgId: string,
  imageFileId: string,
  sourceId?: string,
  userId?: string | null,
): Promise<PhotoObservation | null> {
  const file =
    (await platform().files.read(orgId, imageFileId, "medium")) ??
    (await platform().files.read(orgId, imageFileId, "original"));
  if (!file) return null;
  const imageB64 = Buffer.from(file.bytes).toString("base64");
  try {
    // FREE-TEXT: parseObservation takes JSON or plain prose about the photo, both kept
    const r = await platform().ai.invoke({
      orgId,
      userId: userId ?? undefined,
      capability: "classify-image",
      input: {
        image_b64: imageB64,
        image_media_type: file.mimeType,
        prompt:
          "Describe ONLY what is physically present in this photo. Reply with JSON " +
          "only, no prose outside it:\n" +
          '{"observations": string, "distinct_items": integer, "items": [{"name": string, "brand": string|null, "qty": integer}], "packaging": "none"|"box"|"sealed"|"opened"|"unknown"}\n\n' +
          '"observations": 2-3 short factual sentences: how many retail units are ' +
          "visible (one loose unit, a sealed multipack of N, a shelf of several); " +
          "the packaging state; any label text you can read (QTY, pack size, " +
          "model/SKU, size, a serial number or service tag, and any PAINT or COLOR " +
          "CODE, if one is printed and clearly legible — read every such code " +
          "VERBATIM, never guess one and never complete a partly-hidden one). " +
          "No speculation, no marketing language.\n" +
          '"distinct_items": how many DIFFERENT things are pictured. Several units ' +
          "of the SAME product is a QUANTITY, not different items — a sealed 10-pack " +
          "of one screw, or three identical mugs, is 1. A penguin humidifier next to " +
          "a frog humidifier is 2. Most photos are 1.\n" +
          '"items": ONLY when distinct_items >= 2 — one entry per DIFFERENT thing, ' +
          "each named as specifically as the photo allows, with how many of that one " +
          "are visible. Otherwise [].\n" +
          // The packaging state is already asked for as prose above; as one
          // key it is data the inbox reads to offer the box tools only when a
          // box is in the picture (#3006). One key, no other text changes.
          '"packaging": "none" when the item is bare (no packaging in frame), ' +
          '"box" when it sits in or on its retail box, carton or blister, "sealed" ' +
          'when that packaging is unopened, "opened" when it has been opened, ' +
          '"unknown" when you cannot tell.',
      },
      source: { kind: "core-scan:photo-observe", id: sourceId ?? "" },
    });
    const out = r.text.trim();
    if (!out) return null;
    return parseObservation(out);
  } catch {
    return null;
  }
}

/**
 * Parse the observation reply. The model is asked for JSON, but a model that
 * ignores that and just writes the prose must NOT cost us the observation — that
 * text is load-bearing for the matchmaker (it's what catches the
 * unit-barcode-on-a-multipack trap). So a parse failure degrades to exactly the
 * pre-2026-07-14 behavior: the whole reply IS the prose, one item, no split offer.
 * Never throws.
 */
export function parseObservation(raw: string): PhotoObservation {
  const flat = (text: string): PhotoObservation => ({
    text: text.slice(0, 1500),
    distinct: 1,
    individuals: [],
    packaging: packagingFromProse(text),
  });
  // Models like to wrap JSON in ```json fences.
  const body = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return flat(raw);
  let obj: unknown;
  try {
    obj = JSON.parse(body.slice(start, end + 1));
  } catch {
    return flat(raw);
  }
  const o = obj as {
    observations?: unknown;
    distinct_items?: unknown;
    items?: unknown;
    packaging?: unknown;
  };
  const text = typeof o.observations === "string" ? o.observations.trim() : "";
  if (!text) return flat(raw);
  return {
    text: text.slice(0, 1500),
    ...normalizeIndividuals(o.items, o.distinct_items),
    packaging: asPackaging(o.packaging) ?? packagingFromProse(text),
  };
}

/**
 * Cross-check a barcode's resolved name against the user's scan photo. A
 * confidently-wrong barcode (a store-local or reused code resolving to an
 * unrelated product) sails through the catalog lookup but won't match what's in
 * frame — the author's eggplant→ginger-brew case. One vision call asks: does the photo
 * plausibly show `resolvedName`? On a clear NO we flag the row (warning note +
 * dropped confidence) so the user double-checks (and a fix then flows to the
 * shared Barcode Intelligence DB); YES / UNSURE leaves it untouched. No-op when
 * there's no scan photo (e.g. hardware-wedge scans). Best-effort + detached.
 */
/** The pending-check bag `enrichBarcodeItem` stashes while a photo-backed barcode
 *  hit is shown as "checking…". crossCheckScanPhoto clears them when it resolves. */
const PENDING_KEYS = ["photo_check_pending", "pending_confidence", "pending_notes", "pending_replaced"] as const;

/** What a lookup's candidate replaced on the row, kept at the photo gate
 *  (enrich.ts) so a candidate the photo contradicts can be taken back (#6100). */
export interface PendingReplaced {
  name: string | null;
  manufacturer: string | null;
  sku: string | null;
  catalog_image_url: string | null;
  catalog_image_file_id: string | null;
  source: string | null;
  category?: string | null;
  entity_type?: string | null;
}

/** True when the cross-check's "corrected" name is really just the name we were
 *  REJECTING, echoed back — a self-contradictory vision reply ("this is NOT an
 *  Anchorman figure … the correct name is Anchorman figure"). Applying it would
 *  rename the item to the exact wrong product, so treat it as "no confident name"
 *  and flag it instead. Case- + punctuation-insensitive, either direction of
 *  containment (the lookup name often carries an extra brand prefix the photo drops). */
export function isNameEcho(correctName: string, rejectedName: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = norm(correctName);
  const b = norm(rejectedName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** The question the scan-photo cross-check asks of the picture: does it show
 *  the product the barcode named, and what is printed on it (the maker, the
 *  brand, the title, and this unit's lot and year made). One vision call answers all of it.
 *  Exported so its recorded answers (tests/fixtures/label-lots) are pinned to
 *  this exact wording. */
export function crossCheckPhotoPrompt(resolvedName: string): string {
  return (
    `A scanned barcode resolved this item to: "${resolvedName}". ` +
    "Look at the photo and decide whether the product visible in it plausibly " +
    "matches that name/identity — consider the product type, packaging, and any " +
    "readable label text, and allow for a generic or differently-angled shot. " +
    'Only answer "no" when the photo clearly shows a DIFFERENT kind of product. ' +
    // Two skeins in one frame: the check read the one WITHOUT the barcode and
    // renamed the row to it (#3884). The code is on one of the things shown.
    'When the photo shows several different products, the barcode is on one of ' +
    'them: answer "yes" when ANY of them plausibly matches, and "no" only when ' +
    'none does. Report "things": how many different products are in the photo. ' +
    "When (and ONLY when) it's a clear mismatch AND the photo's label makes the " +
    "real product unambiguous, also return what the item actually IS — a concise " +
    "retail product name, plus brand if visible. Omit them if you can't read it " +
    "confidently. " +
    'Separately, in "printed", report what is PRINTED on the item or its cover, ' +
    "verbatim and only when clearly legible: the author, artist or maker as " +
    "printed (a book's cover author, a record's artist), the brand as printed, " +
    "the title as printed, and the lot or batch code as printed (a dye lot, a lot " +
    "number, a batch: the code that changes from one production run to the next, " +
    "never the barcode digits, a colour number or an article number), and the year " +
    "this unit was made as printed (a wine's vintage, a coin's year: four digits, " +
    'never a best-before date, a copyright year or a "since" or "established" year). ' +
    "Never complete or translate them; null when not shown. " +
    'Reply with JSON only: {"match":"yes"|"no"|"unsure","reason":"<one short sentence>","things":<integer>,' +
    '"correct_name":"<the real product name, optional>","correct_brand":"<brand, optional>",' +
    '"printed":{"creator":<string|null>,"brand":<string|null>,"title":<string|null>,"lot":<string|null>,"year_made":<string|null>}}.'
  );
}

/** Whether a photo holds more than one different thing, by the cross-check's
 *  own count or the identify pass's: then a barcode's name may be flagged
 *  against it but never replaced from it, and no vote leaves the workspace.
 *  Pure. */
export function photoShowsOtherThings(things: unknown, distinct: unknown): boolean {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : 0);
  return n(things) >= 2 || n(distinct) >= 2;
}

export interface CrossCheckOptions {
  /** Check THIS photo rather than the item's own scan shot. Set when someone
   *  deliberately added a picture: that is the evidence they meant to supply,
   *  and the scan-moment frame is not it. */
  fileId?: string;
  /** Refuse to rename even on a clear image-basis mismatch; raise the flag and
   *  its one-tap fix instead.
   *
   *  For a photo a PERSON added to an already-named item. The gesture is
   *  ambiguous by nature — "the name is right and this picture is better" and
   *  "the name is wrong, here is proof" look identical from the button — so the
   *  reversible reading wins. Being made to tap once to accept a correction
   *  costs a second; having a correct item silently renamed underneath you is
   *  the complaint that started all of this. */
  flagOnly?: boolean;
}

/** Complete a brand-level name from the printed title (label-completes-name.ts).
 *  Adds to the name, never replaces it, and says so on the row. A person's own
 *  name is never touched. */
async function completeNameFromLabel(
  orgId: string,
  itemId: string,
  resolvedName: string,
  printed: { title?: string | null; brand?: string | null } | null | undefined,
): Promise<void> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["suggested_name", "suggested_manufacturer", "suggested_metadata", "ai_notes"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  const current = (row?.suggested_name as string | null) ?? null;
  // The name must still be the one the barcode gave: a person's edit, or a
  // later rename, is not ours to extend.
  if (!current || current.trim().toLowerCase() !== resolvedName.trim().toLowerCase()) return;
  const completed = nameCompletedFromLabel({
    name: current,
    brand: (row?.suggested_manufacturer as string | null) ?? null,
    printedTitle: printed?.title,
    printedBrand: printed?.brand,
  });
  if (!completed) return;
  // Both voices are kept (#4583): the catalog's answer and the label read from
  // the photo; the card's headline names the decisive one.
  const provenanceSet = {
    name_from_label: { was: current },
    field_provenance: {
      ...(((row?.suggested_metadata as { field_provenance?: Record<string, unknown> } | null)?.field_provenance) ?? {}),
      name: withContribution(
        withContribution({ by: "evidence" as const, from: "label" }, { source: "catalog", value: current }),
        { source: "label", value: printed?.title?.trim() || completed, photo: "your photo" },
      ),
    },
  };
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: completed,
      suggested_metadata: mergeMeta(provenanceSet) as never,
      ai_notes: `${(row?.ai_notes as string | null) ?? ""} The name was completed from the label on your photo.`.trim(),
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    .execute();
  // The picture search asks the web for the resolved name, so a completed name
  // is searched, not the brand and a shape (#4583).
  void refreshCatalogImageByName(orgId, itemId, completed, (row?.suggested_manufacturer as string | null) ?? null).catch(() => {});
}

export async function crossCheckScanPhoto(
  orgId: string,
  itemId: string,
  resolvedName: string,
  opts: CrossCheckOptions = {},
): Promise<void> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
  const stored = await db
    .selectFrom("core_scan_inbox_items")
    .select(["image_file_id", "suggested_metadata"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  // A supplied photo replaces the subject of the check, and with it the
  // observation: `photo_observations` describes the scan-moment frame, so
  // reusing it here would answer a question about a different picture.
  const row = opts.fileId ? { ...stored, image_file_id: opts.fileId } : stored;

  const meta = (row?.suggested_metadata ?? {}) as {
    photo_observations?: string;
    photo_observed_for?: string;
    photo_distinct?: unknown;
    photo_check_pending?: boolean;
    pending_confidence?: string;
    pending_notes?: string;
  };
  // The "checking…" gate enrichBarcodeItem set for a photo-backed barcode hit.
  // Whatever this cross-check decides, it MUST resolve the gate so the row can't
  // stay stuck at the damped confidence — confirm (photo agrees / can't verify)
  // and override (rename / flag) both clear it.
  const isGated = meta.photo_check_pending === true;
  const pendingConfidence = typeof meta.pending_confidence === "string" ? meta.pending_confidence : "0.85";
  const pendingNotes = typeof meta.pending_notes === "string" ? meta.pending_notes : "Identified by barcode.";
  /** Release the gate to the CONFIRMED barcode result. `verified` = the photo
   *  positively matched (vs the check merely being unable to run). No-op when the
   *  row was never gated. Atomic key-drop so nothing else's writes are clobbered. */
  const confirmPending = async (verified: boolean): Promise<void> => {
    if (!isGated) return;
    const fresh = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
    await fresh
      .updateTable("core_scan_inbox_items")
      .set({
        ai_confidence: pendingConfidence,
        ai_notes: verified ? `${pendingNotes} Matches your photo.` : pendingNotes,
        suggested_metadata: mergeMeta({}, PENDING_KEYS) as never,
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();
  };

  if (!row?.image_file_id) {
    await confirmPending(false); // no scan photo → nothing to compare; trust the barcode
    return;
  }

  // The identify/observe pass may have ALREADY read this photo and written a
  // factual description of what's in frame (photo_observations). When it did — for
  // THIS image — the question "does the photo show <resolvedName>?" is a TEXT
  // comparison against that description, not a third read of the same pixels. A
  // text `chat` call is cheaper, cacheable, needs no image upload, and a small
  // model handles "does 'silicone ties' match 'red silicone cable ties on a
  // retail card'?" fine. The vision call stays as the fallback for a barcode scan
  // whose photo nothing has described yet.
  const observation =
    meta.photo_observed_for === row.image_file_id && meta.photo_observations?.trim()
      ? meta.photo_observations.trim()
      : null;

  type Verdict = {
    match?: string;
    /** How many different products the photo holds, by the look itself. */
    things?: unknown;
    reason?: string;
    correct_name?: string;
    correct_brand?: string;
    /** What the photo shows AS PRINTED, kept apart from the verdict: the
     *  evidence a route's guess is checked against (scan-evidence.ts). */
    printed?: { creator?: string | null; brand?: string | null; title?: string | null; lot?: string | null; year_made?: string | number | null } | null;
  };
  const parseVerdict = (r: { text: string }): Verdict => {
    const raw = r.text;
    const m = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : raw) as Verdict;
  };

  const askDescription = async (): Promise<Verdict> =>
    parseVerdict(
      // ai-userless: background barcode-vs-photo mismatch cross-check (runs
      // detached from the cron, no request user in scope).
      await platform().ai.invoke({
        orgId,
        capability: "identify-from-text",
        input: { output_schema: VERDICT_OUTPUT_SCHEMA,
          messages: [
            {
              role: "user",
              content:
                `A scanned barcode resolved an item to: "${resolvedName}".\n` +
                `A factual description of the actual photographed item reads:\n"${observation ?? ""}"\n\n` +
                "Does the described item plausibly match that name/identity? Consider product " +
                "type, packaging and any label text; allow for a generic or differently-angled " +
                'shot. Answer "no" ONLY when the description clearly shows a DIFFERENT kind of ' +
                "product.\n" +
                'Reply with JSON only: {"match":"yes"|"no"|"unsure","reason":"<one short sentence>"}.',
            },
          ],
        },
        source: { kind: "core-scan:photo-crosscheck-text", id: itemId },
      }),
    );

  const askPhoto = async (): Promise<Verdict> => {
    const file =
      (await platform().files.read(orgId, row.image_file_id!, "medium")) ??
      (await platform().files.read(orgId, row.image_file_id!, "original"));
    if (!file) throw new Error("no photo bytes");
    return parseVerdict(
      // ai-userless: background barcode-vs-photo mismatch cross-check (runs
      // detached from the cron, no request user in scope).
      await platform().ai.invoke({
        orgId,
        capability: "classify-image",
        input: { output_schema: VERDICT_OUTPUT_SCHEMA,
          image_b64: Buffer.from(file.bytes).toString("base64"),
          image_media_type: file.mimeType,
          prompt: crossCheckPhotoPrompt(resolvedName),
        },
        source: { kind: "core-scan:photo-crosscheck", id: itemId },
      }),
    );
  };

  let verdict: Verdict | null = null;
  let basis: CheckBasis = firstPass(!!observation);
  try {
    verdict = basis === "text" ? await askDescription() : await askPhoto();
    // The cheap pass may only RAISE a mismatch, never conclude one: it read a
    // description, and a description can be wrong about the thing it describes.
    // Escalating to the pixels is what turns a suspicion into a finding, and it
    // is paid for only on the rare frames where the cheap pass objects.
    if (needsEscalation(basis, String(verdict?.match ?? ""))) {
      verdict = await askPhoto();
      basis = "image";
    }
  } catch {
    await confirmPending(false); // can't verify → fall back to the barcode result
    return; // best-effort — a flaky/absent vision provider never blocks anything
  }
  // What the photo showed as printed is evidence about THIS picture, kept
  // whatever the verdict: a name the barcode resolved right can still carry
  // an author the cover contradicts (#3070). Only a look at the pixels can
  // have read it.
  if (basis === "image") await keepPhotoRead(orgId, itemId, row.image_file_id!, verdict?.printed);
  // The lot printed on THIS unit, from the same answer: the pixels' reading
  // when it looked, else the description it compared against. No extra call.
  // A row fact, per unit, filed into the lot-role field (lot-field.ts).
  {
    const lot = basis === "image" ? verdict?.printed?.lot : labelFactsOf(observation).lot;
    if (typeof lot === "string" && lot.trim()) {
      const lotDb = (await platform().tenants.getDb(orgId)) as unknown as Parameters<typeof applyLabelLot>[0];
      await applyLabelLot(lotDb, itemId, lot).catch((e) =>
        console.error("[core-scan] keeping the photo's lot threw:", (e as Error).message),
      );
    }
    // The year this unit was made (a vintage), the same way: one barcode
    // covers every vintage, so it is the unit's, never the product's.
    const year = basis === "image" ? verdict?.printed?.year_made : labelFactsOf(observation).year_made;
    if (yearMadeOf(year)) {
      const yearDb = (await platform().tenants.getDb(orgId)) as unknown as Parameters<typeof applyLabelYearMade>[0];
      await applyLabelYearMade(yearDb, itemId, year).catch((e) =>
        console.error("[core-scan] keeping the photo's year threw:", (e as Error).message),
      );
    }
  }
  const matchVerdict = String(verdict?.match ?? "").toLowerCase();
  if (matchVerdict !== "no") {
    // "yes" / "unsure" → the photo does not contradict the barcode. Release the
    // gate; only a look at the photo itself earns the "matches your photo" note.
    await confirmPending(earnsMatchesYourPhoto(basis, matchVerdict));
    // A barcode that named only the brand does not beat the label: when the
    // pixels read a printed title the name lacks, the name is completed from
    // it (#4583). Only a look at the pixels, and never over a photo of several
    // things, whose title may be another product's.
    if (basis === "image" && !photoShowsOtherThings(verdict?.things, meta.photo_distinct)) {
      await completeNameFromLabel(orgId, itemId, resolvedName, verdict?.printed);
    }
    return; // flag only a clear mismatch
  }
  if (!mayActOnMismatch(basis)) {
    // Unreachable while the escalation above stands, and deliberately kept as
    // the single place the rule is stated: nothing renames, flags or votes off
    // a description alone, however the flow above is later rearranged.
    await confirmPending(false);
    return;
  }
  // A photo of several things cannot overrule the barcode: the code is on one
  // of them, and a name read off another is someone else's. It may still say
  // the photo and the code disagree, never rename or vote (#3884).
  const actOnlyAsFlag = !!opts.flagOnly || photoShowsOtherThings(verdict?.things, meta.photo_distinct);
  const reason = typeof verdict?.reason === "string" ? verdict.reason.trim() : "";
  const correctName = typeof verdict?.correct_name === "string" ? verdict.correct_name.trim() : "";
  const correctBrand = typeof verdict?.correct_brand === "string" ? verdict.correct_brand.trim() : "";

  // The vision call can outlive the request's tenant pool — re-acquire before write.
  const freshDb = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
  const existing = await freshDb
    .selectFrom("core_scan_inbox_items")
    .select(["suggested_name", "barcode_text", "suggested_metadata"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  const prevName = (existing?.suggested_name as string | null) ?? resolvedName;
  const unitLots = unitLotsOf(existing?.suggested_metadata, verdict?.printed?.lot, yearMadeOf(verdict?.printed?.year_made));

  // A "correct name" that merely echoes the name we're REJECTING is not a
  // correction (a self-contradictory vision reply) — don't rename to the exact
  // wrong product; fall through to the mismatch flag. This is what let a photo of
  // yellow yarn get "corrected" to the Anchorman action figure the barcode wrongly
  // resolved to: the model said "not an action figure" yet echoed that name back.
  if (correctName && !isNameEcho(correctName, resolvedName) && !actOnlyAsFlag) {
    // The photo UNAMBIGUOUSLY identifies a different product → the photo wins.
    // The barcode/web-search name is the weakest source (a UPC search can surface a
    // spurious listing), so replace it outright with the photo's identity and treat
    // the photo-derived details as primary. Keep the old name for context + undo.
    await freshDb
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_name: correctName,
        ...(correctBrand ? { suggested_manufacturer: correctBrand } : {}),
        ai_confidence: "0.7",
        // Drop the pending-check gate — this row is now finalized as a correction.
        // identityMeta, NOT mergeMeta: this branch REPLACES the identity, so the
        // rejected one's derived attributes must go with it. Merging only
        // `source` left every other identify-owned key from the wrong product
        // sitting on the row - a photo of an HP monitor, correctly renamed from
        // "Simtronics ... gas detector", kept `category: "gas & flame detector"`
        // and `entity_type: "asset"`, and the matchmaker then re-derived its
        // category from that corpse (reported 2026-08-10). IDENTIFY_OWNED_KEYS
        // exists for exactly this; the call site just wasn't using it.
        // PENDING_KEYS are already inside that list, so the gate still clears.
        suggested_metadata: identityMeta(
          {
            source: "photo",
            photo_corrected: { from: prevName, reason: reason || undefined },
          },
          {
            // The vision read that PRODUCED this correction also produced these.
            // They describe what we renamed TO, so they are not the rejected
            // identity's leftovers and must survive the drop.
            keep: ["photo_observations", "photo_distinct", "photo_individuals", "photo_observed_for"],
          },
        ) as never,
        ai_notes:
          `Renamed from your photo — the lookup ("${prevName}") didn't match the item` +
          (reason ? ` (${reason})` : "") +
          ". Photo details are primary.",
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();
    // Feed the barcode→name fix back to the shared Barcode Intelligence DB as a
    // consensus VOTE (photo-correct, voting as this WORKSPACE): once enough
    // independent workspaces' photos agree, the corrected identity auto-verifies
    // and serves everywhere — no operator ever has to touch a review queue. The
    // system converges on its own; the queue is an audit surface, not a gate.
    if (existing?.barcode_text) {
      void reportBarcodeCorrection({
        upc: existing.barcode_text,
        field: "title",
        was: prevName,
        now: correctName,
        photoCorrect: true,
        orgId,
        lots: unitLots,
      }).catch(() => {});
      if (correctBrand) {
        void reportBarcodeCorrection({
          upc: existing.barcode_text,
          field: "brand",
          was: null,
          now: correctBrand,
          photoCorrect: true,
          orgId,
          lots: unitLots,
        }).catch(() => {});
      }
      // EVICT the shared/tenant caches that taught us the wrong name, then
      // REMEMBER the photo-proven identity in THIS workspace's own cache. The
      // photo just disproved the stored answer, and it is decisive for the item
      // this workspace actually holds — so its next scan of the same code serves
      // the corrected name instead of re-deriving it (or re-fetching fresh junk).
      // Cross-workspace truth still converges only by the votes above.
      void evictBarcodeCaches(orgId, existing.barcode_text)
        .then(() =>
          rememberLocalIdentity(orgId, existing.barcode_text!, {
            // Without this unit's lot or vintage: the next bottle of the same
            // code is another year.
            title: withoutLots(correctName, unitLots) || correctName,
            brand: correctBrand || null,
          }),
        )
        .catch(() => {});
      // AND cast a negative VOTE on the provider answer — the photo disproved it.
      // Not a block: once enough independent workspaces agree, the resolver
      // suppresses this code's junk so it stops re-serving a fresh wrong product
      // each scan. A genuinely-shared UPC never gets suppressed by one workspace.
      void reportBarcodeReject({
        upc: existing.barcode_text,
        reason: reason || "photo shows a different product",
        orgId,
      }).catch(() => {});
    }
    // The catalog image still shows the wrong product (the lookup's picture) —
    // refresh it to match the corrected name.
    void refreshCatalogImageByName(orgId, itemId, correctName, correctBrand || null).catch(() => {});
    return;
  }

  // A LOOKUP'S CANDIDATE the photo contradicts is never kept (#6100): the
  // lookup wrote it at the gate, so the identity it replaced goes back (or the
  // row is left unnamed, never named after another product). The cumin's
  // re-run wrote a J. Jill skirt over "Kania Kreuzkümmel gemahlen" and the
  // check then said "a spice jar, not a skirt" and left the skirt. A name a
  // person's added photo is checked against is not a candidate (not gated),
  // and keeps the flag-only behaviour below.
  if (isGated) {
    const replaced = (meta as { pending_replaced?: PendingReplaced }).pending_replaced ?? null;
    const kept = replaced?.name?.trim() || null;
    await freshDb
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_name: kept,
        suggested_manufacturer: replaced?.manufacturer ?? null,
        suggested_sku: replaced?.sku ?? null,
        catalog_image_url: replaced?.catalog_image_url ?? null,
        catalog_image_file_id: replaced?.catalog_image_file_id ?? null,
        ai_confidence: kept ? "0.6" : "0",
        // identityMeta drops everything the candidate brought (its category,
        // description, raw answer) and lays the replaced identity back.
        suggested_metadata: identityMeta(
          {
            ...(replaced?.source ? { source: replaced.source } : {}),
            ...(replaced?.category ? { category: replaced.category } : {}),
            ...(replaced?.entity_type ? { entity_type: replaced.entity_type } : {}),
            photo_mismatch: { reason: reason || undefined, correct_name: correctName || undefined, rejected_name: resolvedName },
          },
          { alsoDrop: PENDING_KEYS, keep: ["photo_observations", "photo_distinct", "photo_individuals", "photo_observed_for"] },
        ) as never,
        ai_notes:
          `Found online as "${resolvedName}", but your photo shows something else` +
          (reason ? ` (${reason})` : "") +
          (kept ? `, so "${kept}" was kept.` : correctName ? `. It looks like "${correctName}": use that, or name it.` : ", so it was not used. Name it."),
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();
    if (existing?.barcode_text && !photoShowsOtherThings(verdict?.things, meta.photo_distinct)) {
      void reportBarcodeReject({ upc: existing.barcode_text, reason: reason || "photo shows a different product", orgId }).catch(() => {});
      void evictBarcodeCaches(orgId, existing.barcode_text).catch(() => {});
    }
    return;
  }

  // match=no but the photo didn't yield a confident (non-echo) name → flag for a
  // manual fix, and store a structured photo_mismatch so the card can offer the
  // one-tap rename. Drop the pending-check gate — the row is finalized as a mismatch.
  await freshDb
    .updateTable("core_scan_inbox_items")
    .set({
      ai_confidence: "0.3",
      // `correct_name` is what the card's one-tap accept applies. The UI has
      // read this key since the flag was introduced and nothing ever wrote it,
      // so a mismatch that DID know the real product still made you retype it.
      // Under flagOnly it is the whole point: the rename is offered rather than
      // performed, and the offer needs the name.
      suggested_metadata: mergeMeta(
        { photo_mismatch: { reason: reason || undefined, correct_name: correctName || undefined } },
        PENDING_KEYS,
      ) as never,
      ai_notes:
        `⚠ This photo doesn't look like "${resolvedName}" — the barcode may be wrong` +
        (reason ? ` (${reason})` : "") +
        (correctName ? `. It looks like "${correctName}" — tap to use that, or fix the name.` : ". Double-check, or fix the name."),
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    .execute();
  // The photo says the provider answer is wrong even though it couldn't name the
  // real product (a spam/collided code like 198973386273 — a yarn skein that
  // resolves to an action figure, then a reverse-phone site). Downvote it and drop
  // the local cache so a re-scan re-queries; once enough workspaces agree the
  // resolver suppresses it and future scans go straight to photo-first.
  // Not under flagOnly: voting is acting, just at everyone else's expense. If
  // this check is not confident enough to rename one row, it is not confident
  // enough to push a barcode toward suppression for every workspace.
  if (existing?.barcode_text && !actOnlyAsFlag) {
    void reportBarcodeReject({
      upc: existing.barcode_text,
      reason: reason || "photo doesn't match the barcode",
      orgId,
    }).catch(() => {});
    void evictBarcodeCaches(orgId, existing.barcode_text).catch(() => {});
  }
}

/** Why an enrich did nothing, so a caller can tell a real failure from a no-op. */
/** `identify-queued`: the hosted service accepted the photo and will answer
 *  later; the row says so and hosted-identify-job.ts lands the answer. */
export type EnrichOutcome = "identified" | "no-photo-bytes" | "not-identified" | "is-receipt" | "identify-queued";

/** Categories this workspace has recently used, most-used first.
 *
 *  A DB read, not a model call: the identify is shown the vocabulary so it can
 *  REUSE a label instead of inventing a synonym of one. Reuse beats
 *  reconciliation - three shirts scanned together produced "apparel",
 *  "apparel" and "clothing" precisely because each call was blind to the other
 *  two (reported 2026-07-30). Cheap, bounded, and silent on failure: an anchor that
 *  cannot be read is not worth failing an identify over. */
export async function knownCategories(
  db: PhotoEnrichContext["db"],
  limit = 24,
): Promise<string[]> {
  try {
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .select("suggested_metadata")
      .where("status", "!=", "discarded")
      .orderBy("updated_at", "desc")
      .limit(200)
      .execute();
    const counts = new Map<string, number>();
    for (const r of rows) {
      const c = (r.suggested_metadata as { category?: unknown } | null)?.category;
      if (typeof c !== "string" || !c.trim()) continue;
      const label = c.trim();
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([c]) => c);
  } catch {
    return [];
  }
}

/** The image's own text, scored for receipt shape (receipt-shape.ts). The
 *  OCR engine is optional; without it, or on a photo it can read nothing off,
 *  this is the empty shape and the model decides as before. */
export async function receiptShapeOf(bytes: Buffer | Uint8Array): Promise<{ shape: ReceiptShape; ocr_ms: number | null }> {
  const read = await ocrImageText(bytes);
  if (!read) return { shape: noReceiptShape(), ocr_ms: null };
  return { shape: scoreReceiptShape(read.text), ocr_ms: read.ms };
}

/** What the general door does with an image, as one rule the pipeline and
 *  the eval harness share: the shape check first (a receipt-shaped image
 *  never reaches the model), then the model's own verdict, then nothing. */
export type IntakeVerdict =
  | { verdict: "receipt"; decided_by: "shape" | "model" }
  | { verdict: "item"; decided_by: "model" }
  | { verdict: "none"; decided_by: "model" };

export function intakeVerdict(shape: ReceiptShape, outcome: IdentifyOutcome | null): IntakeVerdict {
  if (shape.verdict === "receipt") return { verdict: "receipt", decided_by: "shape" };
  if (!outcome?.identity) return { verdict: "none", decided_by: "model" };
  if (looksLikeReceiptPhoto(outcome.identity, shape.verdict)) return { verdict: "receipt", decided_by: "model" };
  return { verdict: "item", decided_by: "model" };
}

/** Say on the row that it is a receipt being read. A FLAG, not just the
 *  sentence. Between here and the lines landing, the row is a photo with no
 *  name and a finished enrichment - exactly the shape the card reads as
 *  "couldn't identify this photo" - so a receipt upload flashed a failure on
 *  its way to working ("it showed this not-recognized for a moment before it
 *  morphed into the line items", 2026-08-31). Prose in ai_notes cannot be
 *  branched on without matching a sentence; this can. The shape verdict rides
 *  along so a session can say which step decided. */
async function markReadingReceipt(ctx: PhotoEnrichContext, note: string, decided: "shape" | "model", shape: ReceiptShape): Promise<void> {
  // ONE statement (#4890, torn status writes): the note and its finish time
  // used to land first and "reading a receipt" a statement later, so a card
  // polled in between read "finished, no name, not a receipt" and flashed
  // "couldn't identify". State and payload change together or not at all.
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      ai_notes: note,
      ai_suggested_at: new Date(),
      updated_at: new Date(),
      suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
        reading_receipt: true,
        receipt_decided_by: decided,
        receipt_shape: { verdict: shape.verdict, score: shape.score },
      })}::jsonb` as never,
    })
    .where("id", "=", ctx.itemId)
    .execute();
}

export async function enrichPhotoItem(ctx: PhotoEnrichContext): Promise<EnrichOutcome> {
  const outcome = await readPhotoItem(ctx);
  // What the photo read says the item looks like can contradict a picture a
  // lookup gave it before the read finished (a label saying J7 DARK BLUE
  // under a beige skein, #3729): judged again once the read has written.
  await withholdContradictedPicture(ctx.orgId, ctx.db as never, ctx.itemId).catch((err) =>
    console.error(`[core-scan] picture check after the photo read of ${ctx.itemId} failed:`, (err as Error).message),
  );
  // What the photo read transcribed off a label (a pack's count, its lot,
  // its colourway) is written onto the item as read from the label, never
  // over the person's own values (label-quantity.ts, #3729). A bulk bag
  // whose label said "quantity contained 3" stayed x1.
  await applyLabelFacts(ctx.db as never, ctx.itemId).catch((err) =>
    console.error(`[core-scan] reading the label facts of ${ctx.itemId} failed:`, (err as Error).message),
  );
  // A colour the read (or the label) stated may not be the one the picture
  // shows: look for one that shows it (withhold-picture.ts).
  void rechoosePictureForColour(ctx.orgId, ctx.db as never, ctx.itemId).catch((err) =>
    console.error(`[core-scan] choosing a picture in the item's colour for ${ctx.itemId} failed:`, (err as Error).message),
  );
  return outcome;
}

async function readPhotoItem(ctx: PhotoEnrichContext): Promise<EnrichOutcome> {
  // Read the photo bytes via the platform files seam. The medium variant
  // (a resized JPEG: smaller payload, a cheaper vision call) goes to the
  // model; the original goes to the OCR engine, whose photograph pass wants
  // every pixel of print it can get. Either stands in for the other.
  const original = await platform().files.read(ctx.orgId, ctx.imageFileId, "original");
  const file = (await platform().files.read(ctx.orgId, ctx.imageFileId, "medium")) ?? original;
  if (!file) {
    await patchNote(ctx, "Photo bytes unavailable — fill in manually.");
    return "no-photo-bytes";
  }
  const imageB64 = Buffer.from(file.bytes).toString("base64");

  // Heuristic first, the model last. A receipt has a shape its own text
  // gives away (several lines ending in a price, a totals row, a store
  // header, a date), and the receipt parser's line pass reads that shape
  // with no model at all. When the image scores as a receipt it goes to
  // receipt review here, before identify is asked anything: a model asked
  // "what item is this" about a receipt answers with an item (#2916).
  //
  // A person's own answer overrides this. Someone who typed a hint or
  // answered the first look said what the thing is; the shape check must not
  // send their item to the receipt parser over their head.
  const answered = !!ctx.hint || !!ctx.confirmedName || !!ctx.rejectedNames?.length;
  const { shape } = answered ? { shape: noReceiptShape() } : await receiptShapeOf((original ?? file).bytes);
  ctx.db = (await platform().tenants.getDb(ctx.orgId)) as unknown as typeof ctx.db;
  if (intakeVerdict(shape, null).verdict === "receipt") {
    const s = shape.signals;
    await markReadingReceipt(
      ctx,
      `That is a receipt (${s.priced_items} priced line${s.priced_items === 1 ? "" : "s"}${s.totals_row ? " and a total" : ""}): reading its line items.`,
      "shape",
      shape,
    );
    return "is-receipt";
  }

  // A box's own label, with an order open that it can belong to: read by OCR
  // and settled against the order's lines and pack parts, with no model
  // (#5764). What the label cannot settle goes on to identify below.
  if (!answered) {
    const box = await boxLabelPass(ctx.db as never, ctx.itemId, (original ?? file).bytes).catch((err: Error) => {
      console.error(`[core-scan] box label read of ${ctx.itemId} failed:`, err.message);
      return "none" as const;
    });
    if (box !== "none") return "identified";
  }

  const knownCats = await knownCategories(ctx.db);
  const { identity, failure, answeredBy, hostedJob } = await identifyPhoto({
    orgId: ctx.orgId,
    imageB64,
    mediaType: file.mimeType,
    sourceId: ctx.itemId,
    userId: ctx.userId,
    // An answered first look changes the question, so the cached reply to the
    // unanswered one must not be served.
    bypassCache: ctx.force || answered,
    hint: ctx.hint,
    hints: ctx.hints,
    confirmedName: ctx.confirmedName,
    rejectedNames: ctx.rejectedNames,
    knownCategories: knownCats,
    visitorIp: ctx.visitorIp,
    ...(ctx.hostedAnswer ? { hostedAnswer: ctx.hostedAnswer } : {}),
  });
  // identifyImage's vision call can run tens of seconds. When enrichPhotoItem
  // runs detached (after the HTTP response has returned), the request's tenant
  // pool may have been reaped meanwhile — a later write then throws "Cannot use
  // a pool after calling end on the pool". Re-acquire a live handle before any
  // post-vision write (the same guard matchItem uses).
  ctx.db = (await platform().tenants.getDb(ctx.orgId)) as unknown as typeof ctx.db;
  if (!identity && hostedJob) {
    // Not unidentified: the hosted service has the photo and will answer when
    // an engine is back (barcode-intelligence #43). The row says so, keeps no
    // failure, and is left looking unread (no ai_suggested_at) so every
    // surface shows it as still being identified. The job is collected by
    // hosted-identify-job.ts, which lands the answer as if it came at once.
    await ctx.db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_notes: HOSTED_QUEUED_WORDS,
        updated_at: new Date(),
        suggested_metadata: mergeMeta(
          { hosted_identify_job: { id: hostedJob.jobId, since: new Date().toISOString(), user_id: ctx.userId ?? null } },
          ["identify_failure"],
        ) as never,
      })
      .where("id", "=", ctx.itemId)
      .execute();
    const { enqueueHostedIdentifyJob } = await import("./hosted-identify-job.js");
    await enqueueHostedIdentifyJob({ orgId: ctx.orgId, itemId: ctx.itemId, jobId: hostedJob.jobId, imageFileId: ctx.imageFileId, userId: ctx.userId ?? null });
    return "identify-queued";
  }
  if (!identity) {
    // The one true reason, as a sentence from the code (scan-fallback.ts),
    // and the code itself on the row so the card can offer the remedy: the
    // connect link, a retry, or a name field.
    const words = identifyFailureWords(failure);
    await ctx.db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_notes: words.sentence,
        ai_suggested_at: new Date(),
        updated_at: new Date(),
        suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
          identify_failure: { code: failure.code, ...(failure.ai ? { ai: failure.ai } : {}), ...(failure.ai_reason ? { ai_reason: failure.ai_reason } : {}), ...(failure.ai_provider ? { ai_provider: failure.ai_provider } : {}), ...(failure.hosted ? { hosted: failure.hosted } : {}) },
        })}::jsonb` as never,
      })
      .where("id", "=", ctx.itemId)
      .execute();
    // The AI was away for a reason that passes: the person's hint still names
    // the item, and a real read is queued for when it answers (#3819).
    await applyHintWithoutAi(ctx.db, { orgId: ctx.orgId, itemId: ctx.itemId, failure, hint: ctx.hint, hints: ctx.hints, userId: ctx.userId }).catch((err) =>
      console.error(`[core-scan] applying the hint without the AI for ${ctx.itemId} failed:`, (err as Error).message),
    );
    return "not-identified";
  }

  // You photographed a receipt, not a thing. Stop here rather than writing a
  // product identity onto the row: the caller turns it into a receipt session
  // instead, because that is where the line-materialising already lives. Saying
  // so and returning is all this layer should do - a service that reached for the
  // API's orchestration would own two jobs and be testable at neither.
  if (intakeVerdict(shape, { identity }).verdict === "receipt") {
    await markReadingReceipt(ctx, "That looks like a receipt — reading its line items.", "model", shape);
    return "is-receipt";
  }

  // The vision read a barcode off the package → capture it, but ONLY when the
  // item has no hardware-scanned barcode (never clobber a real scan), and flag it
  // AI-read (OCR'd digits can be off — lower trust, surfaced for the user to
  // confirm/scan). This is the "photograph it → recover the barcode" arc.
  let captureBarcode: string | null = null;
  const scanned = await ctx.db
    .selectFrom("core_scan_inbox_items")
    .select("barcode_text")
    .where("id", "=", ctx.itemId)
    .executeTakeFirst();
  if (identity.barcode && !scanned?.barcode_text) captureBarcode = identity.barcode;

  // A product with no barcode is known by its label's product words (#3769):
  // what someone filed under the same words is taken before the AI's own
  // answer, under the network's trust rules (one person's name is shown as
  // such; two people's agreement is not overwritten by one). The words stay on
  // the row, in this workspace, until the item is filed.
  const photoOnly = !scanned?.barcode_text && !captureBarcode;
  const labelWords = photoOnly ? labelWordsOf(identity) : [];
  const known = labelWords.length >= 3 ? await matchLabelWords(labelWords) : null;
  const named: PhotoIdentity = known
    ? { ...identity, name: known.name, brand: known.brand ?? identity.brand, category: known.category ?? identity.category }
    : identity;

  // The ONE thing we need from the current row: which image the stored observation
  // describes. That decides whether a reply carrying no observation of its own can
  // keep the previous one (same photo → still true) or must clear it (retaken photo
  // → a description of something that no longer exists). Nothing else is read: the
  // write below is a DB-side merge, so it can't roll back a concurrent writer.
  const priorObservedFor = ((await ctx.db
    .selectFrom("core_scan_inbox_items")
    .select("suggested_metadata")
    .where("id", "=", ctx.itemId)
    .executeTakeFirst())?.suggested_metadata ?? {}) as { photo_observed_for?: string };
  const overlay = identityOverlay(named, {
    imageFileId: ctx.imageFileId,
    captureBarcode,
    hint: ctx.hint,
    priorObservedFor: priorObservedFor.photo_observed_for ?? null,
  });
  if (labelWords.length >= 3) Object.assign(overlay.set, { label_words: labelWords });
  if (known) Object.assign(overlay.set, { label_known: known.confidence, ...(known.confidence === "single" ? { low_trust: true } : {}) });
  // The card says which AI answered when it was not the first one asked.
  if (answeredBy) Object.assign(overlay.set, { ai_answered_by: answeredBy });
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: named.name,
      suggested_manufacturer: named.brand,
      ...(captureBarcode ? { barcode_text: captureBarcode } : {}),
      suggested_metadata: identityMeta(overlay.set, { keep: overlay.keep }) as never,
      ai_confidence: String(identity.confidence),
      ai_notes: known
        ? known.confidence === "single"
          ? "Named by one person on the barcode network. Check it, or correct it."
          : "Named from its label by the people who filed it."
        : identity.confidence < 0.5
          ? "Identified from photo by vision — low confidence, please verify."
          : "Identified from photo by vision.",
      ai_suggested_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .execute();

  // A SCREENSHOT of a listing already contains a photograph of the item. Crop it
  // out and use THAT, rather than searching the internet for a picture of some
  // other unit of the same product: it is the actual thing, it needs no search
  // or fetch, and it cannot 404 or hotlink-block. Falls through to the image
  // search when this is not a screenshot, which is the ordinary case.
  // A model that read the listing but gave no box (a small model often
  // skips it; the hosted service never sent one) gets one locate call, on
  // this shape only: the listing's own photo beats a stock shot of another
  // unit, and a V2 in place of the original was what the search found (#3853).
  const box = identity.product_photo_box ?? (identity.listing ? await locateListingPhoto(ctx) : null);
  const cropped = await catalogFromScreenshot(ctx, box).catch(() => false);
  if (cropped) return "identified";

  // Auto-suggest a clean CATALOG image for a photographed item — the user's own
  // photo stays as "yours", but a studio shot from an image search on the
  // resolved name gives a nicer display. Previously this only ran on a barcode
  // mismatch, so a clean photo identify never got a catalog photo. Best-effort;
  // honors a user-picked image (refreshCatalogImageByName checks the lock).
  void refreshCatalogImageByName(ctx.orgId, ctx.itemId, named.name, named.brand).catch(() => {});
  return "identified";
}

/** The item's box inside a listing screenshot, from the segmentation pass:
 *  the largest thing it found, held to the same size rule as a box the
 *  identify reply gives (parseProductRegion). Null when nothing usable. */
async function locateListingPhoto(ctx: PhotoEnrichContext): Promise<SplitBox | null> {
  const found = await detectSplitItems(ctx.orgId, ctx.imageFileId, ctx.userId ?? null).catch(() => null);
  return found ? listingPhotoBoxFrom(found.items) : null;
}

/** Pure: the largest usable box among what segmentation found. */
export function listingPhotoBoxFrom(items: ReadonlyArray<{ box: SplitBox | null }>): SplitBox | null {
  let best: SplitBox | null = null;
  for (const it of items) {
    const b = parseProductRegion({ box: it.box });
    if (b && (!best || b.w * b.h > best.w * best.h)) best = b;
  }
  return best;
}

/** Crop the item's photograph out of a screenshot and make it the catalog image.
 *
 *  Returns whether it did, so the caller can skip the image search: when we have
 *  a picture of the actual item there is nothing to go looking for.
 *
 *  Awaited rather than detached, unlike the search it replaces, because the two
 *  race for the same column. Detaching both meant whichever finished last won,
 *  which is a coin toss between "your item" and "a stock photo of a different
 *  one". It is one call on a rare shape, and the enrich is already detached from
 *  the request.
 *
 *  Never overrides a human's pick, same rule as everything else that writes this
 *  column. */
async function catalogFromScreenshot(
  ctx: PhotoEnrichContext,
  box: { x: number; y: number; w: number; h: number } | null,
): Promise<boolean> {
  if (!box) return false;
  const row = await ctx.db
    .selectFrom("core_scan_inbox_items")
    .select(["suggested_metadata", "catalog_image_url", "catalog_image_file_id"])
    .where("id", "=", ctx.itemId)
    .executeTakeFirst();
  const meta = (row?.suggested_metadata ?? {}) as Record<string, unknown>;
  if (meta.catalog_image_user_set === true) return false;

  // pad: 0 — the box IS the page's photo rectangle, so the pixels just outside it
  // are the chrome this crop exists to remove.
  const cut = await cropRegion(ctx.orgId, ctx.imageFileId, box, { pad: 0 });
  if (!cut.fileId) return false;
  const croppedId = cut.fileId;

  // Onto the undo stack, so Revert walks back to whatever was showing before,
  // exactly as it does for a hand-picked image. Each apply pushes the image it
  // REPLACES, tagged with where THAT one came from; `catalog_source` then
  // records what is showing now, so the next push can label it in turn.
  const history = pushStep(
    seedHistory(meta.catalog_history, meta.orig_catalog as { url: string | null; file_id: string | null } | undefined),
    { url: row?.catalog_image_url ?? null, file_id: row?.catalog_image_file_id ?? null },
    meta.catalog_source as CatalogSource | undefined,
  );

  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      catalog_image_file_id: croppedId,
      catalog_image_url: null,
      // NOT `catalog_image_user_set` — no human chose this, and claiming they did
      // would silence the ✨ pick-best ranker permanently. Its own flag says the
      // same thing to the passes that must not clobber it, and no more.
      suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
        catalog_image_from_screenshot: true,
        catalog_source: "crop",
        catalog_history: history,
        /** The crop's own file id, so the photo-options strip can offer it as a
         *  pane after the user has moved to a web image and wants it back. */
        screenshot_crop_file_id: croppedId,
      })}::jsonb` as never,
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .execute();
  return true;
}
