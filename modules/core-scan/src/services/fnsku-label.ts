// The product title printed on an Amazon fulfilment sticker, read off the
// scan frame's text (#4933).
//
// An FNSKU (X00 plus seven letters and digits) identifies a unit only inside
// Amazon's warehouse: no public database resolves it. But the sticker prints
// what the unit is right under the code, and the scan frame already holds
// that sticker, so the title is read off the frame we have instead of asking
// the person to take another photo:
//
//   ||||||||||||||||||||
//   X002XNBLID
//   Anker 4-Port Ultra Slim USB 3.0 Data H...
//   New
//
// fnskuLabelTitle is pure: the OCR text in, the title out, or null when the
// code's line is not in the text (the title is never guessed from text that
// is not under it). nameFromAmazonLabel reads the frame and writes the row.

import { sql, type Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { FNSKU_NOTE, FNSKU_READ_NOTE } from "@cobblr/platform-contract/scan-copy";
import type { IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";
import type { CoreScanDB } from "../db.js";
import { identifyPhoto, refreshCatalogImageByName } from "./enrich-photo.js";
import { ocrImageText } from "./ocr.js";
import { uprightBytes } from "./trim-margins.js";

/** The condition line Amazon prints last. */
const CONDITION = /^(new|used\b.*|refurbished\b.*|renewed\b.*|collectible\b.*|like new\b.*|open box\b.*)$/i;

/** Characters OCR swaps for one another on a printed code. */
const CONFUSABLE: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6" };
const fold = (s: string): string =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[OQDILSBZG]/g, (c) => CONFUSABLE[c] ?? c);

/** A line that is mostly not words: a barcode's bars read as glyphs. */
const noise = (s: string): boolean => (s.match(/[a-z]/gi)?.length ?? 0) < Math.max(3, s.length * 0.4);

/** The printed title, without Amazon's truncation mark, or null. */
export function fnskuLabelTitle(text: string | null | undefined, code: string): string | null {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const want = fold(code);
  if (want.length < 8) return null;
  const at = lines.findIndex((l) => fold(l).includes(want));
  if (at < 0) return null;
  const parts: string[] = [];
  for (const line of lines.slice(at + 1, at + 4)) {
    if (CONDITION.test(line)) break;
    if (noise(line)) {
      if (parts.length) break;
      continue;
    }
    parts.push(line);
    if (parts.length === 2) break;
  }
  const title = parts
    .join(" ")
    .replace(/\s*(\.{2,}|…)\s*$/, "")
    .replace(/\s+/g, " ")
    .replace(/[\s,;:-]+$/, "")
    .trim();
  const words = title.split(" ").filter((w) => /[a-z]{2}/i.test(w));
  return words.length >= 2 && title.length >= 6 ? title : null;
}

/** What the label says under its code, as read, when it made no confident
 *  title: offered to the person as a one-tap guess, never written as a name. */
export function fnskuLabelText(text: string | null | undefined, code: string): string | null {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const at = lines.findIndex((l) => fold(l).includes(fold(code)));
  if (at < 0) return null;
  const words = lines
    .slice(at + 1, at + 3)
    .filter((l) => !CONDITION.test(l) && /[a-z]{2}/i.test(l))
    .join(" ")
    .replace(/\s*(\.{2,}|…)\s*$/, "")
    .trim();
  return words.length >= 3 ? words : null;
}

// ── reading the label on the frame the scan already has ─────────────────────

/** How the title was read: the OCR engine (no model) or the vision model. */
export type LabelReadBy = "ocr" | "vision";

/**
 * Name a scanned FNSKU from the title printed on its sticker, read off the
 * scan frame: the OCR engine first (free, local), the vision model only when
 * OCR found no title. A named row searches its picture by that name, like a
 * catalog hit. With no title, the row says it is an Amazon label whose title
 * could not be read, offers whatever text was read as a one-tap guess, and
 * keeps the read's own failure (could not reach the AI, or the AI could not
 * read it), so the card never says "the AI could not read this one" about a
 * read that never happened (#4933).
 */
export async function nameFromAmazonLabel(ctx: { db: Kysely<CoreScanDB>; orgId: string; itemId: string; userId?: string | null; code: string }): Promise<{ title: string | null; by: LabelReadBy | null }> {
  const row = await ctx.db.selectFrom("core_scan_inbox_items").select(["image_file_id"]).where("id", "=", ctx.itemId).executeTakeFirst();
  let title: string | null = null;
  let by: LabelReadBy | null = null;
  let labelText: string | null = null;
  let failure: IdentifyFailure | null = null;
  if (row?.image_file_id) {
    // The ORIGINAL: the title is small print, and a medium variant is a
    // third of the frame's width.
    const file =
      (await platform().files.read(ctx.orgId, row.image_file_id, "original")) ??
      (await platform().files.read(ctx.orgId, row.image_file_id, "medium"));
    const upright = file ? await uprightBytes(file.bytes) : null;
    if (upright) {
      const read = await ocrImageText(upright.bytes);
      title = fnskuLabelTitle(read?.text, ctx.code);
      if (title) by = "ocr";
      else {
        labelText = fnskuLabelText(read?.text, ctx.code);
        const out = await identifyPhoto({
          orgId: ctx.orgId,
          imageB64: upright.bytes.toString("base64"),
          mediaType: `image/${upright.meta.format === "jpg" ? "jpeg" : (upright.meta.format ?? "jpeg")}`,
          sourceId: ctx.itemId,
          userId: ctx.userId,
          hint: "This is an Amazon fulfilment label; the product's title is printed under the barcode.",
        }).catch((err: unknown) => ({ identity: null, failure: { code: "ai_unavailable", reason: (err as Error).message } as IdentifyFailure, hostedJob: undefined }));
        if (out.identity?.name) {
          title = out.identity.name;
          by = "vision";
        } else if (!out.hostedJob) failure = out.failure ?? null;
      }
    }
  }
  const db = (await platform().tenants.getDb(ctx.orgId)) as unknown as Kysely<CoreScanDB>;
  if (title) {
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_name: title,
        ai_confidence: by === "ocr" ? "0.7" : "0.6",
        ai_notes: FNSKU_READ_NOTE,
        suggested_metadata: sql`((coalesce(suggested_metadata, '{}'::jsonb) - 'identify_failure') - 'label_text') || ${JSON.stringify({ code_type: "fnsku", label_title: title, label_read_by: by })}::jsonb` as never,
        ai_suggested_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", ctx.itemId)
      .execute();
    void refreshCatalogImageByName(ctx.orgId, ctx.itemId, title, null).catch(() => {});
    return { title, by };
  }
  await db
    .updateTable("core_scan_inbox_items")
    .set({
      ai_confidence: "0",
      ai_notes: FNSKU_NOTE,
      suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({
        code_type: "fnsku",
        ...(labelText ? { label_text: labelText } : {}),
        ...(failure ? { identify_failure: { code: failure.code, ...(failure.ai ? { ai: failure.ai } : {}), ...(failure.ai_reason ? { ai_reason: failure.ai_reason } : {}), ...(failure.ai_provider ? { ai_provider: failure.ai_provider } : {}) } } : {}),
      })}::jsonb` as never,
      ai_suggested_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", ctx.itemId)
    .execute();
  return { title: null, by: null };
}
