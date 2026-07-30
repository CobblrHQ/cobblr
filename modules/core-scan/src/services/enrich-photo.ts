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

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tidyTruncatedName } from "./item-name.js";
import type { CoreScanDB } from "../db.js";
import { reportBarcodeCorrection, reportBarcodeReject } from "./barcode-corrections.js";
import { identityMeta, mergeMeta } from "./metadata.js";
import { evictBarcodeCaches, rememberLocalIdentity } from "./barcode-cache.js";
import { searchImages, rankImageOptions, imageQuery, mediaSearchExtras } from "./ddg-images.js";

/** Re-fetch the catalog image to match a (corrected) name. The card prefers the
 *  downloaded `catalog_image_file_id` over `catalog_image_url`, so a rename left
 *  the OLD product's picture showing; here we set the best new external URL and
 *  clear the stale download so the right image renders. Detached-safe (no bearer:
 *  the external URL renders directly; a later backfill can download it). */
export async function refreshCatalogImageByName(
  orgId: string,
  itemId: string,
  name: string,
  brand?: string | null,
): Promise<void> {
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
  if ((cur?.suggested_metadata as { catalog_image_user_set?: boolean } | null)?.catalog_image_user_set) return;
  // Sharpen a weak title with author + media word (the same extras the
  // photo-options strip uses) so a book finds its cover, not generic images.
  const { author, mediaWord } = mediaSearchExtras(cur?.suggested_candidates as Array<{ fields?: Record<string, unknown> }> | null);
  const extra = [author, mediaWord].filter(Boolean).join(" ") || null;
  const q = imageQuery(name, brand, extra);
  const pool = await searchImages(q, 24).catch(() => []);
  // Try to DOWNLOAD the top candidates into core-files, falling through until one
  // stores. Storing just the top RAW url (as this did) left many tiles empty: a
  // product-page image often hotlink-blocks or 404s in the browser, and there was
  // no fallback to the next result (the author, 2026-07-24). downloadCatalogImage handles
  // SSRF-guard + retries + size limits and stamps catalog_image_file_id. Dynamic
  // import because enrich.ts imports THIS module — a static import would cycle.
  const candidates = rankImageOptions(pool, brand, q)
    .map((r) => r.url)
    .filter((u): u is string => !!u)
    .slice(0, 4);
  if (!candidates.length) return;
  const { downloadCatalogImage } = await import("./enrich.js");
  for (const url of candidates) {
    if (await downloadCatalogImage({ db, orgId, itemId }, url)) return; // stored → done
  }
  // None downloaded — keep the best raw url as a last resort (renders if it isn't
  // hotlink-blocked), never regressing to no image at all.
  await db
    .updateTable("core_scan_inbox_items")
    .set({ catalog_image_url: candidates[0], catalog_image_file_id: null, updated_at: new Date() })
    .where("id", "=", itemId)
    .execute();
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
  /** The user's research hint (a short text correction) — folded into the vision
   *  identify as an AUTHORITATIVE correction that overrides the visual read, so
   *  a hint naming a DIFFERENT item than the obvious one re-identifies to it. */
  hint?: string;
  /** Every correction the user has given this item, oldest first (standingHints).
   *  The prompt weighs later over earlier; `hint` is the newest. */
  hints?: string[];
  /** REPLAY: re-parse the model's PREVIOUS reply with today's code, never call
   *  the provider (see RerunBody.no_ai). Beats `force`, which means the opposite. */
  replay?: boolean;
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
   *  unknowable (the author, 2026-07-30). */
  color: string | null;
  entityType: "asset" | "part" | null;
  /** A known series/franchise this titled work belongs to (Harry Potter,
   *  Little House on the Prairie), or null. Used to group + tag siblings. */
  series: string | null;
  confidence: number;
  /** A UPC/EAN the vision model read off the package (digits only), or null.
   *  OCR'd — lower trust than a hardware scan, so it's captured as AI-read. */
  barcode: string | null;
  /** A serial number / service tag read verbatim off the item's label, or null.
   *  A universal identifier — routed to the destination table's native
   *  serial_number field on commit. OCR'd, so read-only-if-legible + never
   *  guessed (the prompt forbids completing a partial one). */
  serial_number: string | null;
  /** Factual prose on what's physically in frame (packaging state, "sealed
   *  10-pack, label says QTY 10"). The matchmaker's corroboration — it OUTRANKS
   *  listing-derived counts and is what catches the unit-barcode-on-a-multipack
   *  trap. Empty string when the model didn't say (an older cached reply). */
  observations: string;
  /** How many DISTINCT things are pictured. Several units of the SAME product is
   *  a quantity, not a split (a sealed 10-pack of screws is ONE thing) — only
   *  genuinely different items count. 1 for the overwhelmingly common case. */
  distinct: number;
  /** Those things, named — present when `distinct` >= 2, so the inbox can offer
   *  "split into individuals" and LIST them without a second vision call. */
  individuals: Individual[];
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
  const items = Array.isArray(rawItems) ? rawItems : [];
  const individuals = items
    .map((it): Individual | null => {
      const i = (it ?? {}) as { name?: unknown; brand?: unknown; qty?: unknown };
      const name = typeof i.name === "string" ? i.name.trim() : "";
      if (!name) return null;
      const qty = Number(i.qty);
      return {
        name: name.slice(0, 200),
        brand: typeof i.brand === "string" && i.brand.trim() ? i.brand.trim().slice(0, 120) : null,
        qty: Number.isFinite(qty) && qty >= 1 ? Math.min(Math.round(qty), 999) : 1,
      };
    })
    .filter((x): x is Individual => x !== null);

  // Trust the LIST over the count. A model that claims 3 but names 2 has named
  // what it actually saw, and the offer must never promise an item it can't
  // produce. A count with NO names is still honest ("2 items — split?"); the
  // names then come from the segmentation pass the user opted into.
  const claimed = Number(claimedDistinct);
  const distinct =
    individuals.length >= 2
      ? individuals.length
      : Number.isFinite(claimed) && claimed >= 1
        ? Math.min(Math.round(claimed), 99)
        : 1;
  return { distinct, individuals };
}

/**
 * The pure image → identity step: one metered `identify-image` call + tolerant
 * parse. No DB, no file IO — bytes in (base64), identity out. Returns null when
 * there's no vision provider, the call/parse fails, or the model can't name a
 * single item. Shared by `enrichPhotoItem` (which then writes the row) and the
 * super-admin eval seam (docs/operations/ai-prompt-eval-harness.md, P3).
 */
export async function identifyImage(
  orgId: string,
  imageB64: string,
  mediaType: string,
  sourceId?: string,
  userId?: string | null,
  bypassCache?: boolean,
  hint?: string,
  cacheOnly?: boolean,
  /** Every correction the user has given this item, oldest first. The prompt
   *  shows them all and weighs later over earlier; `hint` stays the newest for
   *  callers that only carry one. */
  hints?: string[],
  /** The workspace's existing category vocabulary, so the identify reuses a
   *  label instead of inventing a synonym of one. */
  knownCategories?: string[],
): Promise<PhotoIdentity | null> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const r = await platform().ai.invoke({
      orgId,
      capability: "identify-image",
      input: {
        image_b64: imageB64,
        image_media_type: mediaType,
        ...(hint ? { user_hint: hint } : {}),
        ...(hints && hints.length > 1 ? { user_hints: hints } : {}),
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
      // A REPLAY re-parses the previous reply with today's code and never calls
      // out; a miss throws in the no-provider family and we return null below.
      cache_only: cacheOnly,
    });
    // OpenAI returns {role, content}; Anthropic returns {text} — tolerate both.
    const res = r.result as { text?: string; content?: string };
    const raw = res.text ?? res.content ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : raw);
  } catch (err) {
    // Surfaced (was silent) so a vision failure is diagnosable, not a mystery
    // "no vision provider" note. Still returns null — the caller degrades.
    console.error("[core-scan] identifyImage failed:", (err as Error)?.message ?? err);
    return null;
  }
  return parseIdentityReply(parsed);
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
  const name = tidyTruncatedName(
    str(p.name) ||
    [str(p.product_line), str(p.product_name)].filter(Boolean).join(" ").trim() ||
    str(p.product_name) ||
    str(p.title) ||
    "",
  );
  if (!name) return null;
  const rawType = str(p.entity_type) || str(p.type);
  const et: "asset" | "part" | null = rawType === "asset" || rawType === "part" ? rawType : null;
  return {
    name,
    brand: str(p.brand) || str(p.manufacturer).split(",")[0]?.trim() || null,
    category: str(p.category) || str(p.product_line) || null,
    color: str(p.color) || null,
    entityType: et,
    series: str(p.series) || str(p.franchise) || null,
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
    // The same read also tells us what's in frame and how many DIFFERENT things
    // there are. An older reply cached before the prompt asked for these simply
    // has neither: observations "" and distinct 1 — i.e. exactly the pre-change
    // behavior, no split offer. Never a reason to fail the identify.
    observations: str(p.observations).slice(0, 1500),
    ...normalizeIndividuals(p.items, p.distinct_items),
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
  // A serial/service tag read off the label → carried to the destination table's
  // native serial_number field on commit (see inbox.ts commit).
  if (identity.serial_number) set.serial_number = identity.serial_number;
  if (opts.captureBarcode) set.barcode_source = "ai-photo";
  const pack = parsePackSize(identity.name);
  if (pack) set.pack_size = pack;
  // Keep the correction visible to the matchmaker as an authoritative hint.
  if (opts.hint) set.user_hint = opts.hint;

  const keep: string[] = [];
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
}

export async function observeScanPhoto(
  orgId: string,
  imageFileId: string,
  sourceId?: string,
  userId?: string | null,
  cacheOnly?: boolean,
): Promise<PhotoObservation | null> {
  const file =
    (await platform().files.read(orgId, imageFileId, "medium")) ??
    (await platform().files.read(orgId, imageFileId, "original"));
  if (!file) return null;
  const imageB64 = Buffer.from(file.bytes).toString("base64");
  try {
    const r = await platform().ai.invoke({
      orgId,
      userId: userId ?? undefined,
      capability: "classify-image",
      cache_only: cacheOnly,
      input: {
        image_b64: imageB64,
        image_media_type: file.mimeType,
        prompt:
          "Describe ONLY what is physically present in this photo. Reply with JSON " +
          "only, no prose outside it:\n" +
          '{"observations": string, "distinct_items": integer, "items": [{"name": string, "brand": string|null, "qty": integer}]}\n\n' +
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
          "are visible. Otherwise [].",
      },
      source: { kind: "core-scan:photo-observe", id: sourceId ?? "" },
    });
    const res = r.result as { text?: string; content?: string };
    const out = (res.text ?? res.content ?? "").trim();
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
  };
  const text = typeof o.observations === "string" ? o.observations.trim() : "";
  if (!text) return flat(raw);
  return { text: text.slice(0, 1500), ...normalizeIndividuals(o.items, o.distinct_items) };
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
const PENDING_KEYS = ["photo_check_pending", "pending_confidence", "pending_notes"] as const;

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

export async function crossCheckScanPhoto(
  orgId: string,
  itemId: string,
  resolvedName: string,
): Promise<void> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["image_file_id", "suggested_metadata"])
    .where("id", "=", itemId)
    .executeTakeFirst();

  const meta = (row?.suggested_metadata ?? {}) as {
    photo_observations?: string;
    photo_observed_for?: string;
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

  let verdict: { match?: string; reason?: string; correct_name?: string; correct_brand?: string } | null =
    null;
  try {
    const r = observation
      ? // ai-userless: background barcode-vs-photo mismatch cross-check (runs
        // detached from the cron, no request user in scope).
        await platform().ai.invoke({
          orgId,
          capability: "chat",
          input: {
            messages: [
              {
                role: "user",
                content:
                  `A scanned barcode resolved an item to: "${resolvedName}".\n` +
                  `A factual description of the actual photographed item reads:\n"${observation}"\n\n` +
                  "Does the described item plausibly match that name/identity? Consider product " +
                  "type, packaging and any label text; allow for a generic or differently-angled " +
                  'shot. Answer "no" ONLY when the description clearly shows a DIFFERENT kind of ' +
                  "product. When (and only when) it's a clear mismatch AND the description names the " +
                  "real product unambiguously, also return what it actually IS (concise retail name " +
                  "+ brand if present). Omit them otherwise.\n" +
                  'Reply with JSON only: {"match":"yes"|"no"|"unsure","reason":"<one short sentence>",' +
                  '"correct_name":"<optional>","correct_brand":"<optional>"}.',
              },
            ],
          },
          source: { kind: "core-scan:photo-crosscheck-text", id: itemId },
        })
      : await (async () => {
          const file =
            (await platform().files.read(orgId, row.image_file_id!, "medium")) ??
            (await platform().files.read(orgId, row.image_file_id!, "original"));
          if (!file) throw new Error("no photo bytes");
          // ai-userless: background barcode-vs-photo mismatch cross-check (runs
          // detached from the cron, no request user in scope).
          return platform().ai.invoke({
            orgId,
            capability: "classify-image",
            input: {
              image_b64: Buffer.from(file.bytes).toString("base64"),
              image_media_type: file.mimeType,
              prompt:
                `A scanned barcode resolved this item to: "${resolvedName}". ` +
                "Look at the photo and decide whether the product visible in it plausibly " +
                "matches that name/identity — consider the product type, packaging, and any " +
                "readable label text, and allow for a generic or differently-angled shot. " +
                'Only answer "no" when the photo clearly shows a DIFFERENT kind of product. ' +
                "When (and ONLY when) it's a clear mismatch AND the photo's label makes the " +
                "real product unambiguous, also return what the item actually IS — a concise " +
                "retail product name, plus brand if visible. Omit them if you can't read it " +
                "confidently. " +
                'Reply with JSON only: {"match":"yes"|"no"|"unsure","reason":"<one short sentence>",' +
                '"correct_name":"<the real product name, optional>","correct_brand":"<brand, optional>"}.',
            },
            source: { kind: "core-scan:photo-crosscheck", id: itemId },
          });
        })();
    const res = r.result as { text?: string; content?: string };
    const raw = res.text ?? res.content ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    verdict = JSON.parse(m ? m[0] : raw);
  } catch {
    await confirmPending(false); // can't verify → fall back to the barcode result
    return; // best-effort — a flaky/absent vision provider never blocks anything
  }
  const matchVerdict = String(verdict?.match ?? "").toLowerCase();
  if (matchVerdict !== "no") {
    // "yes" / "unsure" → the photo does not contradict the barcode. Release the
    // gate; only a positive "yes" earns the "matches your photo" note.
    await confirmPending(matchVerdict === "yes");
    return; // flag only a clear mismatch
  }
  const reason = typeof verdict?.reason === "string" ? verdict.reason.trim() : "";
  const correctName = typeof verdict?.correct_name === "string" ? verdict.correct_name.trim() : "";
  const correctBrand = typeof verdict?.correct_brand === "string" ? verdict.correct_brand.trim() : "";

  // The vision call can outlive the request's tenant pool — re-acquire before write.
  const freshDb = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
  const existing = await freshDb
    .selectFrom("core_scan_inbox_items")
    .select(["suggested_name", "barcode_text"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  const prevName = (existing?.suggested_name as string | null) ?? resolvedName;

  // A "correct name" that merely echoes the name we're REJECTING is not a
  // correction (a self-contradictory vision reply) — don't rename to the exact
  // wrong product; fall through to the mismatch flag. This is what let a photo of
  // yellow yarn get "corrected" to the Anchorman action figure the barcode wrongly
  // resolved to: the model said "not an action figure" yet echoed that name back.
  if (correctName && !isNameEcho(correctName, resolvedName)) {
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
        suggested_metadata: mergeMeta(
          {
            source: "photo",
            photo_corrected: { from: prevName, reason: reason || undefined },
          },
          PENDING_KEYS,
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
      }).catch(() => {});
      if (correctBrand) {
        void reportBarcodeCorrection({
          upc: existing.barcode_text,
          field: "brand",
          was: null,
          now: correctBrand,
          photoCorrect: true,
          orgId,
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
            title: correctName,
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

  // match=no but the photo didn't yield a confident (non-echo) name → flag for a
  // manual fix, and store a structured photo_mismatch so the card can offer the
  // one-tap rename. Drop the pending-check gate — the row is finalized as a mismatch.
  await freshDb
    .updateTable("core_scan_inbox_items")
    .set({
      ai_confidence: "0.3",
      suggested_metadata: mergeMeta({ photo_mismatch: { reason: reason || undefined } }, PENDING_KEYS) as never,
      ai_notes:
        `⚠ This photo doesn't look like "${resolvedName}" — the barcode may be wrong` +
        (reason ? ` (${reason})` : "") +
        ". Double-check, or fix the name.",
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    .execute();
  // The photo says the provider answer is wrong even though it couldn't name the
  // real product (a spam/collided code like 198973386273 — a yarn skein that
  // resolves to an action figure, then a reverse-phone site). Downvote it and drop
  // the local cache so a re-scan re-queries; once enough workspaces agree the
  // resolver suppresses it and future scans go straight to photo-first.
  if (existing?.barcode_text) {
    void reportBarcodeReject({
      upc: existing.barcode_text,
      reason: reason || "photo doesn't match the barcode",
      orgId,
    }).catch(() => {});
    void evictBarcodeCaches(orgId, existing.barcode_text).catch(() => {});
  }
}

/** Why an enrich did nothing — so a REPLAY can report "nothing cached to replay"
 *  instead of looking like a silent no-op, and never be mistaken for a failure. */
export type EnrichOutcome = "identified" | "no-photo-bytes" | "not-identified" | "nothing-cached";

/** Categories this workspace has recently used, most-used first.
 *
 *  A DB read, not a model call: the identify is shown the vocabulary so it can
 *  REUSE a label instead of inventing a synonym of one. Reuse beats
 *  reconciliation - three shirts scanned together produced "apparel",
 *  "apparel" and "clothing" precisely because each call was blind to the other
 *  two (the author, 2026-07-30). Cheap, bounded, and silent on failure: an anchor that
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

export async function enrichPhotoItem(ctx: PhotoEnrichContext): Promise<EnrichOutcome> {
  // Read the photo bytes via the platform files seam. Prefer the medium
  // variant — resized JPEG, smaller payload + a cheaper vision call —
  // falling back to the original if there's no medium.
  const file =
    (await platform().files.read(ctx.orgId, ctx.imageFileId, "medium")) ??
    (await platform().files.read(ctx.orgId, ctx.imageFileId, "original"));
  if (!file) {
    await patchNote(ctx, "Photo bytes unavailable — fill in manually.");
    return "no-photo-bytes";
  }
  const imageB64 = Buffer.from(file.bytes).toString("base64");

  const knownCats = await knownCategories(ctx.db);
  const identity = await identifyImage(
    ctx.orgId,
    imageB64,
    file.mimeType,
    ctx.itemId,
    ctx.userId,
    // A replay must never bypass the cache — that's what would make it pay.
    !ctx.replay && (ctx.force || !!ctx.hint),
    ctx.hint,
    ctx.replay,
    ctx.hints,
    knownCats,
  );
  // identifyImage's vision call can run tens of seconds. When enrichPhotoItem
  // runs detached (after the HTTP response has returned), the request's tenant
  // pool may have been reaped meanwhile — a later write then throws "Cannot use
  // a pool after calling end on the pool". Re-acquire a live handle before any
  // post-vision write (the same guard matchItem uses).
  ctx.db = (await platform().tenants.getDb(ctx.orgId)) as unknown as typeof ctx.db;
  if (!identity) {
    // A REPLAY with nothing cached for this image. There is no new information,
    // so leave the row EXACTLY as it was — stamping the couldn't-identify note
    // here would destroy a perfectly good name to report that we declined to
    // spend money.
    if (ctx.replay) return "nothing-cached";
    // No vision provider, the model/parse failed, or no single item was visible.
    await patchNote(
      ctx,
      "Photo couldn't be auto-identified (no vision provider configured, the model errored, or no single item was visible). Fill in manually.",
    );
    return "not-identified";
  }

  // The vision read a barcode off the package → capture it, but ONLY when the
  // item has no hardware-scanned barcode (never clobber a real scan), and flag it
  // AI-read (OCR'd digits can be off — lower trust, surfaced for the user to
  // confirm/scan). This is the "photograph it → recover the barcode" arc.
  let captureBarcode: string | null = null;
  if (identity.barcode) {
    const cur = await ctx.db
      .selectFrom("core_scan_inbox_items")
      .select("barcode_text")
      .where("id", "=", ctx.itemId)
      .executeTakeFirst();
    if (!cur?.barcode_text) captureBarcode = identity.barcode;
  }

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
  const overlay = identityOverlay(identity, {
    imageFileId: ctx.imageFileId,
    captureBarcode,
    hint: ctx.hint,
    priorObservedFor: priorObservedFor.photo_observed_for ?? null,
  });
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: identity.name,
      suggested_manufacturer: identity.brand,
      ...(captureBarcode ? { barcode_text: captureBarcode } : {}),
      suggested_metadata: identityMeta(overlay.set, { keep: overlay.keep }) as never,
      ai_confidence: String(identity.confidence),
      ai_notes:
        identity.confidence < 0.5
          ? "Identified from photo by vision — low confidence, please verify."
          : "Identified from photo by vision.",
      ai_suggested_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .execute();

  // Auto-suggest a clean CATALOG image for a photographed item — the user's own
  // photo stays as "yours", but a studio shot from an image search on the
  // resolved name gives a nicer display. Previously this only ran on a barcode
  // mismatch, so a clean photo identify never got a catalog photo. Best-effort;
  // honors a user-picked image (refreshCatalogImageByName checks the lock).
  void refreshCatalogImageByName(ctx.orgId, ctx.itemId, identity.name, identity.brand).catch(() => {});
  return "identified";
}
