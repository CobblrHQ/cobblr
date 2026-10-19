// Combining look-alike scans and taking a combine back.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { appendScanHistory } from "../../services/scan-history.js";
import { isMachineReadCode } from "../../services/barcode-source.js";
import { filedQuantityOf } from "../../services/filed-quantity.js";
import { sql } from "kysely";
import { z } from "zod";
import { platform, countOf } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../../db.js";
import { asyncHandler, requireRole } from "../util.js";
import { dropMeta, mergeMeta } from "../../services/metadata.js";
import { pickPrimaryId, unionCandidateFields, traitsHaveUnique, combinedQuantityOf, type CombineItem, type CombineCandidate } from "../../services/combine-merge.js";
import { SCAN_UNDO_ACTIONS } from "@cobblr/platform-contract/scan-recovery";
import { uncombinePlan, type CombineUndo } from "../../services/uncombine.js";
import { optionalField } from "@cobblr/platform-contract/optional-fields";
import { served } from "./shared.js";

export const combineRouter = Router({ mergeParams: true });

// "These look like the same product — combine." Merge several pending items
// (you scanned 4 of one thing, but one pack carried a different barcode) into a
// SINGLE line with the summed quantity. The distinct barcodes are preserved in
// the kept item's metadata (merged_barcodes) so nothing is lost; the others are
// soft-discarded (restorable). Always user-initiated — never auto-merges across
// barcodes, since a different UPC can be a genuinely different SKU.
const CombineBody = z.object({
  ids: z.array(z.string()).min(2).max(50),
  /** Which item's name/photo to keep; defaults to the first id. */
  keep_id: optionalField(z.string()),
});

// AI-TOOL: change_scan_item
combineRouter.post(
  "/inbox/combine",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = CombineBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_request", message: "ids[] (2–50) required" } });
      return;
    }
    const db = tenantDb(req);
    const { ids, keep_id } = parsed.data;
    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "in", ids)
      .where("status", "=", "pending")
      .execute();
    if (rows.length < 2) {
      res.status(400).json({ error: { code: "too_few", message: "need ≥2 pending items to combine" } });
      return;
    }
    // Keep the richest identity by default (a VIN-decoded vehicle over a photo of
    // it), not just rows[0]; the user's explicit keep_id still wins.
    const primaryId = pickPrimaryId(rows as unknown as CombineItem[], keep_id);
    const primary = rows.find((r) => r.id === primaryId) ?? rows[0];
    if (!primary) {
      res.status(400).json({ error: { code: "too_few", message: "need ≥2 pending items to combine" } });
      return;
    }
    const others = rows.filter((r) => r.id !== primary.id);
    // UNION the fields: the primary keeps its own values and fills its GAPS from the
    // others (same table only). So merging a plate photo into a VIN vehicle carries
    // the colour + plate across instead of discarding them.
    const unionedCandidates = unionCandidateFields(
      primary as unknown as CombineItem,
      others as unknown as CombineItem[],
    );
    // A unique-tracked kind (a vehicle, a machine — declared traits, never the
    // name) captured twice is ONE thing seen two ways, not two units: don't sum
    // sightings into phantom quantity. Fungible stock still sums (×4 soap).
    let uniqueKind = false;
    const topCandKind = (primary.suggested_candidates as CombineCandidate[] | null)?.[0]?.kind;
    if (topCandKind) {
      try {
        const ctx = tenantContext(req);
        const kinds = await platform().entities.listKindsForOrg(ctx.org.id);
        uniqueKind = traitsHaveUnique(kinds.find((k) => k.id === topCandKind)?.traits ?? null);
      } catch {
        /* trait lookup is best-effort — fall back to the summing default */
      }
    }
    // A case label beside one of its items is the case's count (#3729).
    const totalQty = combinedQuantityOf(rows.map((r) => ({ quantity: filedQuantityOf(r.quantity), barcode_text: r.barcode_text })), uniqueKind);
    const barcodes = Array.from(new Set(rows.map((r) => r.barcode_text).filter(Boolean))) as string[];
    const meta = (primary.suggested_metadata ?? {}) as Record<string, unknown>;
    // Barcode authority: if the kept item's own barcode was READ BY AI (OCR, can
    // be a digit off) — or it has none — but a merged item carries a SCANNED one,
    // adopt the scanned code as the kept item's barcode. So you keep the photo +
    // name you chose AND end up with the real barcode. Clear the ai-photo flag.
    const primaryAiBarcode = isMachineReadCode((meta as { barcode_source?: string }).barcode_source);
    const scannedBarcode = others.find(
      (o) =>
        o.barcode_text &&
        !isMachineReadCode((o.suggested_metadata as { barcode_source?: string } | null)?.barcode_source),
    )?.barcode_text;
    const adoptBarcode = (primaryAiBarcode || !primary.barcode_text) && scannedBarcode ? scannedBarcode : null;
    // Never lose the user's real photo on a merge: if the kept item has no photo
    // of its own but a merged one does, carry it over (e.g. "keep the scanned
    // listing" still keeps the picture you took).
    const adoptPhoto = !primary.image_file_id ? others.find((o) => o.image_file_id)?.image_file_id ?? null : null;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        quantity: totalQty,
        ...(adoptBarcode ? { barcode_text: adoptBarcode } : {}),
        ...(adoptPhoto ? { image_file_id: adoptPhoto } : {}),
        ...(unionedCandidates ? { suggested_candidates: JSON.stringify(unionedCandidates) as never } : {}),
        suggested_metadata: mergeMeta(
          {
            ...(barcodes.length ? { merged_barcodes: barcodes } : {}),
            merged_count: rows.length,
            // What Undo combine gives back (#3639), from either row.
            combine_undo: {
              absorbed: others.map((o) => o.id),
              quantity_before: filedQuantityOf(primary.quantity),
              quantity_after: totalQty,
              barcode_before: primary.barcode_text,
              barcode_after: adoptBarcode ?? primary.barcode_text,
              image_before: primary.image_file_id,
              image_after: adoptPhoto ?? primary.image_file_id,
              candidates_before: primary.suggested_candidates ?? [],
              candidates_after: unionedCandidates ?? primary.suggested_candidates ?? [],
              merged_barcodes_before: meta.merged_barcodes ?? null,
              merged_count_before: meta.merged_count ?? null,
              previous: (meta.combine_undo as CombineUndo | undefined) ?? null,
            } satisfies CombineUndo,
          },
          // Adopting a merged item's barcode means its AI-photo-read barcode_source
          // no longer applies — drop it (what metaNoSource used to do by omission).
          adoptBarcode ? ["barcode_source"] : [],
        ) as never,
        updated_at: new Date(),
      })
      .where("id", "=", primary.id)
      .execute();
    // Losers carry a marker: their quantities were SUMMED into the primary, so
    // restoring one alone would double-count. Their way back is Undo combine
    // (scan-recovery.ts), which returns both rows.
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "discarded",
        suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || jsonb_build_object('combined_into', ${primary.id}::text)` as never,
        updated_at: new Date(),
      })
      .where(
        "id",
        "in",
        others.map((o) => o.id),
      )
      .execute();
    await appendScanHistory(db, primary.id, { action: "combine", note: `${countOf(rows.length, "item")}` });
    res.json(await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", primary.id).executeTakeFirst());
  }),
);

// Undo combine (#3639), from either row: the kept one or one it absorbed.
// The absorbed rows come back to the inbox as they were, and the kept row
// gives back the quantity (and the barcode, photo and fields) the combine
// added, keeping anything the person changed since.
// AI-TOOL: change_scan_item
combineRouter.post(
  "/inbox/:id/uncombine",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = String(req.params.id);
    const db = tenantDb(req);
    const start = await db.selectFrom("core_scan_inbox_items").select(["id", "suggested_metadata"]).where("id", "=", id).executeTakeFirst();
    if (!start) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const into = (start.suggested_metadata as { combined_into?: string } | null)?.combined_into;
    const kept = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", into || start.id).executeTakeFirst();
    const keptMeta = (kept?.suggested_metadata ?? {}) as { combine_undo?: CombineUndo };
    const pointing = kept
      ? await db
          .selectFrom("core_scan_inbox_items")
          .select(["id", "quantity"])
          .where(sql<string>`suggested_metadata ->> 'combined_into'`, "=", kept.id)
          .where("status", "=", "discarded")
          .execute()
      : [];
    // This combine's rows: the snapshot's, or (a combine made before it
    // existed) every row that still points here.
    const wanted = keptMeta.combine_undo ? new Set(keptMeta.combine_undo.absorbed) : null;
    const absorbed = wanted ? pointing.filter((r) => wanted.has(r.id)) : pointing;
    if (!kept || !absorbed.length) {
      res.status(409).json({ error: { code: "not_combined", message: "This scan is not combined with another, so there is nothing to undo." } });
      return;
    }
    const keptName = kept.suggested_name ? `"${kept.suggested_name}"` : "The combined scan";
    if (kept.status === "resolved") {
      res.status(409).json({
        error: {
          code: "combined_filed",
          message: `${keptName} was already filed with the combined quantity. Press ${SCAN_UNDO_ACTIONS.sendBack} on it in Recently committed first, then ${SCAN_UNDO_ACTIONS.undoCombine}.`,
          item_id: kept.id,
        },
      });
      return;
    }
    if (kept.status !== "pending") {
      res.status(409).json({
        error: {
          code: "combined_deleted",
          message: `${keptName} is in Recently deleted. Press ${SCAN_UNDO_ACTIONS.restore} on it first, then ${SCAN_UNDO_ACTIONS.undoCombine}.`,
          item_id: kept.id,
        },
      });
      return;
    }
    const plan = uncombinePlan(kept, absorbed.map((r) => filedQuantityOf(r.quantity)));
    const now = new Date();
    await db
      .updateTable("core_scan_inbox_items")
      .set({ ...plan.set, suggested_metadata: mergeMeta(plan.metaSet, plan.metaDrop) as never, updated_at: now } as never)
      .where("id", "=", kept.id)
      .execute();
    await db
      .updateTable("core_scan_inbox_items")
      .set({ status: "pending", suggested_metadata: dropMeta(["combined_into"]) as never, updated_at: now })
      .where("id", "in", absorbed.map((r) => r.id))
      .where("status", "=", "discarded")
      .execute();
    await appendScanHistory(db, kept.id, { action: "uncombine", note: `${absorbed.length + 1} items` });
    res.json({ kept: await served(req, await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", kept.id).executeTakeFirstOrThrow()), restored: absorbed.map((r) => r.id) });
  }),
);
