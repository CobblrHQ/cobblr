// Action handlers, registered at module load via api/index.ts's
// side-effect call.
//
// The autonomous photo-sort is a WIRE, not a cron baked into the
// module: a default binding fires core-scan:identify-photo on every
// core-scan.scan.received. Photo-only rows get vision-identified
// detached; the user can edit / disable the wire on /wires like any
// other. (The barcode fast path stays inline in POST /scan — it needs
// the request's ~12s budget for responsiveness.)

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";
import { enrichPhotoItem } from "../services/enrich-photo.js";
import { routeScannedReceiptPhoto } from "../services/receipt-photo.js";
import { autoRankCatalogPhoto, readPhotoRankEnabled } from "../services/auto-rank.js";
import { runReceiptBackfill } from "../services/receipt-backfill.js";

let registered = false;

export function registerScanHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("core-scan.confirm-receipt-arrival", async (ctx) => {
    const args = (ctx.args as { batch_id?: string } | null) ?? {};
    // The ambient entity is the fallback subject, same as purchases'
    // mark-arrived: run from a receipt's own context, no args needed.
    const batchId = args.batch_id ?? (ctx.entity?.id || undefined);
    if (!batchId) return { ok: true, skipped: "no receipt in scope" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreScanDB>;
    const row = await db
      .selectFrom("core_scan_batches")
      .select(["id", "shipment_confirmed_at"])
      .where("id", "=", batchId)
      .executeTakeFirst();
    if (!row) return { ok: false, error: "receipt not found" };
    // Idempotent: two devices, or a stale card, answering twice is harmless.
    if (row.shipment_confirmed_at) return { ok: true, skipped: "already confirmed" };
    await db
      .updateTable("core_scan_batches")
      .set({ shipment_confirmed_at: new Date() })
      .where("id", "=", batchId)
      .execute();
    return { ok: true, confirmed: true };
  });

  platform().actions.registerHandler("core-scan.fill-fields-from-receipts", async (ctx) => {
    const args = (ctx.args ?? {}) as { dry_run?: boolean };
    return await runReceiptBackfill(ctx.orgId, { dryRun: args.dry_run === true });
  });

  platform().actions.registerHandler("core-scan.identify-photo", async (ctx) => {
    const itemId = ctx.event?.payload?.itemId;
    if (typeof itemId !== "string" || !itemId) return { ok: true, skipped: "no item id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreScanDB>;
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["barcode_text", "image_file_id", "ai_suggested_at"])
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!row) return { ok: true, skipped: "no such row" };
    // Only photo-only scans — a barcode is handled inline by the fast
    // path; an already-enriched row isn't re-run by the auto wire.
    if (row.barcode_text || !row.image_file_id || row.ai_suggested_at) {
      return { ok: true, skipped: "not an un-enriched photo-only scan" };
    }
    const outcome = await enrichPhotoItem({
      db,
      orgId: ctx.orgId,
      itemId,
      imageFileId: row.image_file_id,
      userId: ctx.userId,
    });
    // You photographed a receipt. Hand it to the receipt parser instead of
    // filing the paper as a thing you own — the same route an uploaded receipt
    // takes, so the batch, the line items and the purchases order are all
    // created by the one code path. No enriched event: nothing was identified,
    // and the lines raise their own.
    if (outcome === "is-receipt") {
      const r = await routeScannedReceiptPhoto({
        orgId: ctx.orgId,
        itemId,
        fileId: row.image_file_id,
        userId: ctx.userId,
      });
      if (r.routed) return { ok: true, receipt: true, items: r.items };
      // Called it a receipt and could not read it. The row is still there, so
      // say why on it rather than leaving a nameless photo and no explanation.
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          ai_notes: `That looked like a receipt, but its line items could not be read (${r.reason}). Re-run to identify it as an item instead.`,
          ai_suggested_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", itemId)
        .execute();
      return { ok: true, receipt: false, skipped: r.reason };
    }
    void platform().events.emit("core-scan.scan.enriched", { orgId: ctx.orgId, itemId });
    return { ok: true, identified: true };
  });

  // The ALWAYS-ON catalog-photo pick (Phase F). Fired by a seeded wire on every
  // core-scan.scan.enriched — the event both intake paths reach once a NAME
  // exists (the barcode fast path and the photo identify above), which is what
  // the image search needs. It is a wire for the same Pillar-C reason the photo
  // sort is: editable + inspectable on /wires, not a cron in a module.
  //
  // TWO gates, because this one SPENDS on its own: the workspace must have opted
  // in (readPhotoRankEnabled — no config row means off, so silence is free), and
  // then the per-row cost guard decides (shouldAutoRank: never over a user's own
  // pick, never twice for the same resolved name, never on a filed row). The
  // manual ✨ Pick best button needs neither — a press IS the consent.
  platform().actions.registerHandler("core-scan.rank-catalog-photo", async (ctx) => {
    const itemId = ctx.event?.payload?.itemId;
    if (typeof itemId !== "string" || !itemId) return { ok: true, skipped: "no item id" };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreScanDB>;
    if (!(await readPhotoRankEnabled(db))) return { ok: true, skipped: "not enabled for this workspace" };
    const outcome = await autoRankCatalogPhoto({ db, orgId: ctx.orgId, itemId, userId: ctx.userId });
    if (!outcome.ranked) return { ok: true, skipped: outcome.skipped };
    return { ok: true, ranked: true, url: outcome.url, reason: outcome.reason, ranked_over: outcome.rankedOver };
  });

  // Generic, PURE identify — "what is this?" from any combination of a photo
  // and/or captured measurements + observations. No reads or writes of other
  // modules' entities: it takes the inputs, calls the AI, and RETURNS the
  // suggestion ({ name, brand, category, confidence }). The caller (e.g. a
  // capture app) decides what to do with it — keep its own deterministic name,
  // or use this. User-invokable so a Tier-B app can ask. Measurements ride the
  // identify-image prompt via core-ai's measurementContext (a caliper pins what
  // a photo can't). Best-effort: no AI provider / unparseable → identified:false.
  platform().actions.registerHandler("core-scan.identify", async (ctx) => {
    const a = (ctx.args as Record<string, unknown> | null) ?? {};
    const input: Record<string, unknown> = {};
    if (a.measurements && typeof a.measurements === "object") input.measurements = a.measurements;
    if (a.observations && typeof a.observations === "object") input.observations = a.observations;
    const fileId = typeof a.image_file_id === "string" && a.image_file_id ? a.image_file_id : null;
    if (fileId) {
      const file =
        (await platform().files.read(ctx.orgId, fileId, "medium")) ??
        (await platform().files.read(ctx.orgId, fileId, "original"));
      if (file) {
        input.image_b64 = Buffer.from(file.bytes).toString("base64");
        input.image_media_type = file.mimeType;
      }
    }
    if (!input.measurements && !input.observations && !input.image_b64) {
      return { ok: true, identified: false, reason: "nothing to identify" };
    }
    try {
      const r = await platform().ai.invoke({
        orgId: ctx.orgId,
        userId: ctx.userId,
        capability: "identify-image",
        input,
        source: { kind: "core-scan:identify", id: fileId ?? "args" },
      });
      const res = r.result as { text?: string; content?: string };
      const raw = res.text ?? res.content ?? "";
      const m = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(m ? m[0] : raw) as { name?: string; brand?: string; category?: string; confidence?: number };
      const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
      if (!name) return { ok: true, identified: false };
      return {
        ok: true,
        identified: true,
        name,
        brand: typeof parsed?.brand === "string" ? parsed.brand.trim() || null : null,
        category: typeof parsed?.category === "string" ? parsed.category.trim() || null : null,
        confidence: typeof parsed?.confidence === "number" ? parsed.confidence : null,
      };
    } catch {
      return { ok: true, identified: false };
    }
  });
}
