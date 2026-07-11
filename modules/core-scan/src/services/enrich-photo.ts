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
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";
import { reportBarcodeCorrection } from "./barcode-corrections.js";
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
  const pool = await searchImages(imageQuery(name, brand, extra), 24).catch(() => []);
  const best = rankImageOptions(pool, brand)[0]?.url;
  if (!best) return;
  await db
    .updateTable("core_scan_inbox_items")
    .set({ catalog_image_url: best, catalog_image_file_id: null, updated_at: new Date() })
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
  entityType: "asset" | "part" | null;
  /** A known series/franchise this titled work belongs to (Harry Potter,
   *  Little House on the Prairie), or null. Used to group + tag siblings. */
  series: string | null;
  confidence: number;
  /** A UPC/EAN the vision model read off the package (digits only), or null.
   *  OCR'd — lower trust than a hardware scan, so it's captured as AI-read. */
  barcode: string | null;
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
): Promise<PhotoIdentity | null> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const r = await platform().ai.invoke({
      orgId,
      capability: "identify-image",
      input: { image_b64: imageB64, image_media_type: mediaType, ...(hint ? { user_hint: hint } : {}) },
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
  // Tolerant extraction: the model mostly returns the asked-for {name,…} shape,
  // but sometimes a richer one ({product_line, product_name, type, manufacturer,
  // …}). Pull a usable name from either rather than failing the whole identify
  // (which surfaced as a bogus "no vision provider" note — the vision worked).
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const p = (parsed ?? {}) as Record<string, unknown>;
  const name =
    str(p.name) ||
    [str(p.product_line), str(p.product_name)].filter(Boolean).join(" ").trim() ||
    str(p.product_name) ||
    str(p.title) ||
    "";
  if (!name) return null;
  const rawType = str(p.entity_type) || str(p.type);
  const et: "asset" | "part" | null = rawType === "asset" || rawType === "part" ? rawType : null;
  return {
    name,
    brand: str(p.brand) || str(p.manufacturer).split(",")[0]?.trim() || null,
    category: str(p.category) || str(p.product_line) || null,
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
  };
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
export async function observeScanPhoto(
  orgId: string,
  imageFileId: string,
  sourceId?: string,
  userId?: string | null,
): Promise<string | null> {
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
      input: {
        image_b64: imageB64,
        image_media_type: file.mimeType,
        prompt:
          "Describe ONLY what is physically present in this photo, in 2-3 short " +
          "factual sentences: how many retail units are visible (one loose unit, " +
          "a sealed multipack of N, a shelf of several); the packaging state; any " +
          "label text you can read (QTY, pack size, model/SKU, size). " +
          "No speculation, no marketing language. Reply with plain text only.",
      },
      source: { kind: "core-scan:photo-observe", id: sourceId ?? "" },
    });
    const res = r.result as { text?: string; content?: string };
    const out = (res.text ?? res.content ?? "").trim();
    return out ? out.slice(0, 1500) : null;
  } catch {
    return null;
  }
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
export async function crossCheckScanPhoto(
  orgId: string,
  itemId: string,
  resolvedName: string,
): Promise<void> {
  const db = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
  const row = await db
    .selectFrom("core_scan_inbox_items")
    .select(["image_file_id"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  if (!row?.image_file_id) return; // no scan photo → nothing to compare against
  const file =
    (await platform().files.read(orgId, row.image_file_id, "medium")) ??
    (await platform().files.read(orgId, row.image_file_id, "original"));
  if (!file) return;
  const imageB64 = Buffer.from(file.bytes).toString("base64");

  let verdict: { match?: string; reason?: string; correct_name?: string; correct_brand?: string } | null =
    null;
  try {
    // ai-userless: background barcode-vs-photo mismatch cross-check (runs
    // detached from the cron, no request user in scope).
    const r = await platform().ai.invoke({
      orgId,
      capability: "classify-image",
      input: {
        image_b64: imageB64,
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
    const res = r.result as { text?: string; content?: string };
    const raw = res.text ?? res.content ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    verdict = JSON.parse(m ? m[0] : raw);
  } catch {
    return; // best-effort — a flaky/absent vision provider never blocks anything
  }
  if (String(verdict?.match ?? "").toLowerCase() !== "no") return; // flag only a clear mismatch
  const reason = typeof verdict?.reason === "string" ? verdict.reason.trim() : "";
  const correctName = typeof verdict?.correct_name === "string" ? verdict.correct_name.trim() : "";
  const correctBrand = typeof verdict?.correct_brand === "string" ? verdict.correct_brand.trim() : "";

  // The vision call can outlive the request's tenant pool — re-acquire before write.
  const freshDb = (await platform().tenants.getDb(orgId)) as unknown as Kysely<CoreScanDB>;
  const existing = await freshDb
    .selectFrom("core_scan_inbox_items")
    .select(["suggested_metadata", "suggested_name", "barcode_text"])
    .where("id", "=", itemId)
    .executeTakeFirst();
  const baseMeta = (existing?.suggested_metadata as Record<string, unknown> | null) ?? {};
  const prevName = (existing?.suggested_name as string | null) ?? resolvedName;

  if (correctName) {
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
        suggested_metadata: sql`${JSON.stringify({
          ...baseMeta,
          source: "photo",
          photo_corrected: { from: prevName, reason: reason || undefined },
        })}::jsonb` as never,
        ai_notes:
          `Renamed from your photo — the lookup ("${prevName}") didn't match the item` +
          (reason ? ` (${reason})` : "") +
          ". Photo details are primary.",
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();
    // Feed the barcode→name fix back to the shared Barcode Intelligence DB so the
    // next scan of this code gets the right product. Best-effort; detached (no
    // user) → lands as a pending proposal, which is the right trust level for an
    // auto-applied correction.
    if (existing?.barcode_text) {
      void reportBarcodeCorrection({
        upc: existing.barcode_text,
        field: "title",
        was: prevName,
        now: correctName,
      }).catch(() => {});
    }
    // The catalog image still shows the wrong product (the lookup's picture) —
    // refresh it to match the corrected name.
    void refreshCatalogImageByName(orgId, itemId, correctName, correctBrand || null).catch(() => {});
    return;
  }

  // match=no but the photo didn't yield a confident name → flag for a manual fix,
  // and store a structured photo_mismatch so the card can offer the one-tap rename.
  const meta = {
    ...baseMeta,
    photo_mismatch: { reason: reason || undefined },
  };
  await freshDb
    .updateTable("core_scan_inbox_items")
    .set({
      ai_confidence: "0.3",
      suggested_metadata: sql`${JSON.stringify(meta)}::jsonb` as never,
      ai_notes:
        `⚠ This photo doesn't look like "${resolvedName}" — the barcode may be wrong` +
        (reason ? ` (${reason})` : "") +
        ". Double-check, or fix the name.",
      updated_at: new Date(),
    })
    .where("id", "=", itemId)
    .execute();
}

export async function enrichPhotoItem(ctx: PhotoEnrichContext): Promise<void> {
  // Read the photo bytes via the platform files seam. Prefer the medium
  // variant — resized JPEG, smaller payload + a cheaper vision call —
  // falling back to the original if there's no medium.
  const file =
    (await platform().files.read(ctx.orgId, ctx.imageFileId, "medium")) ??
    (await platform().files.read(ctx.orgId, ctx.imageFileId, "original"));
  if (!file) {
    await patchNote(ctx, "Photo bytes unavailable — fill in manually.");
    return;
  }
  const imageB64 = Buffer.from(file.bytes).toString("base64");

  const identity = await identifyImage(
    ctx.orgId,
    imageB64,
    file.mimeType,
    ctx.itemId,
    ctx.userId,
    ctx.force || !!ctx.hint,
    ctx.hint,
  );
  // identifyImage's vision call can run tens of seconds. When enrichPhotoItem
  // runs detached (after the HTTP response has returned), the request's tenant
  // pool may have been reaped meanwhile — a later write then throws "Cannot use
  // a pool after calling end on the pool". Re-acquire a live handle before any
  // post-vision write (the same guard matchItem uses).
  ctx.db = (await platform().tenants.getDb(ctx.orgId)) as unknown as typeof ctx.db;
  if (!identity) {
    // No vision provider, the model/parse failed, or no single item was visible.
    await patchNote(
      ctx,
      "Photo couldn't be auto-identified (no vision provider configured, the model errored, or no single item was visible). Fill in manually.",
    );
    return;
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

  // Preserve a user's deliberate image pick across a re-identify. This write
  // REPLACES suggested_metadata wholesale, which would drop catalog_image_user_set
  // → the refreshCatalogImageByName below (and matchItem's) would then clobber the
  // image the user chose. Carry the lock (and its revert backup) forward. A "this
  // is wrong" re-run clears the lock BEFORE reaching here (so it still re-images);
  // a plain re-run keeps the pick — the sweet spot: re-run respects a user-chosen
  // image when the item is correct, and re-images only when it was flagged wrong.
  const priorMeta = ((await ctx.db
    .selectFrom("core_scan_inbox_items")
    .select("suggested_metadata")
    .where("id", "=", ctx.itemId)
    .executeTakeFirst())?.suggested_metadata ?? {}) as {
    catalog_image_user_set?: boolean;
    orig_catalog?: unknown;
  };
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: identity.name,
      suggested_manufacturer: identity.brand,
      ...(captureBarcode ? { barcode_text: captureBarcode } : {}),
      suggested_metadata: sql`${JSON.stringify({
        source: "vision",
        category: identity.category,
        entity_type: identity.entityType,
        ...(identity.series ? { series: identity.series } : {}),
        ...(captureBarcode ? { barcode_source: "ai-photo" } : {}),
        ...(parsePackSize(identity.name) ? { pack_size: parsePackSize(identity.name) } : {}),
        // Preserve the correction so the matchmaker (which runs after this
        // wholesale metadata rewrite) still sees it as an authoritative hint.
        ...(ctx.hint ? { user_hint: ctx.hint } : {}),
        // Keep a user's image pick + its revert backup alive across re-identify.
        ...(priorMeta.catalog_image_user_set ? { catalog_image_user_set: true } : {}),
        ...(priorMeta.orig_catalog ? { orig_catalog: priorMeta.orig_catalog } : {}),
      })}::jsonb` as never,
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
}
