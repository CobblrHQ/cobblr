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

interface PhotoEnrichContext {
  db: Kysely<CoreScanDB>;
  /** Org UUID — for the metered core-ai vision call. */
  orgId: string;
  /** Inbox row id. */
  itemId: string;
  /** The scanned photo's core-files id. */
  imageFileId: string;
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
  confidence: number;
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
): Promise<PhotoIdentity | null> {
  let parsed: Record<string, unknown> | null = null;
  try {
    const r = await platform().ai.invoke({
      orgId,
      capability: "identify-image",
      input: { image_b64: imageB64, image_media_type: mediaType },
      source: { kind: "core-scan:photo", id: sourceId ?? "eval" },
    });
    // OpenAI returns {role, content}; Anthropic returns {text} — tolerate both.
    const res = r.result as { text?: string; content?: string };
    const raw = res.text ?? res.content ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : raw);
  } catch {
    return null;
  }
  const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
  if (!name) return null;
  const et = parsed?.entity_type === "asset" || parsed?.entity_type === "part" ? parsed.entity_type : null;
  return {
    name,
    brand: typeof parsed?.brand === "string" ? parsed.brand.trim() || null : null,
    category: typeof parsed?.category === "string" ? parsed.category.trim() || null : null,
    entityType: et,
    confidence: clamp01(typeof parsed?.confidence === "number" ? parsed.confidence : 0.5),
  };
}

async function patchNote(ctx: PhotoEnrichContext, note: string): Promise<void> {
  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({ ai_notes: note, ai_suggested_at: new Date(), updated_at: new Date() })
    .where("id", "=", ctx.itemId)
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

  const identity = await identifyImage(ctx.orgId, imageB64, file.mimeType, ctx.itemId);
  if (!identity) {
    // No vision provider, the model/parse failed, or no single item was visible.
    await patchNote(
      ctx,
      "Photo couldn't be auto-identified (no vision provider configured, the model errored, or no single item was visible). Fill in manually.",
    );
    return;
  }

  await ctx.db
    .updateTable("core_scan_inbox_items")
    .set({
      suggested_name: identity.name,
      suggested_manufacturer: identity.brand,
      suggested_metadata: sql`${JSON.stringify({
        source: "vision",
        category: identity.category,
        entity_type: identity.entityType,
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
}
