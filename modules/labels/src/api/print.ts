// /print — snapshot the current queue into a batch + per-item
// prints, then clear the queue. Returns the rendered batch with QR
// SVGs so the client can drop them straight into a print preview.

import { Router } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { qrSvg } from "./qr.js";
import { renderLabelsPdf, type PrintItem } from "../print/pdf.js";
import { SIZES } from "../print/layout.js";

export const printRouter = Router({ mergeParams: true });

// Block the read-only `guest` role from every request on this router —
// these fire physical print jobs, so guests must never reach them.
// (Audit 2026-06-26 P0 #1.)
printRouter.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
  }
  next();
});

// ── direct-to-printer (CUPS via core-print) ──────────────────────────
// Render the queue to a print-ready PDF with the companion app renderer
// (pdf-lib + qrcode, Rollo-tuned). The web hands the returned base64 to
// core-print to dispatch — labels owns CONTENT, core-print owns the device.

printRouter.get(
  "/sizes",
  asyncHandler(async (_req, res) => {
    res.json({ items: SIZES.map((s) => ({ key: s.key, label: s.label, printer: s.printer })) });
  }),
);

const RenderBody = z.object({
  size_key: z.string().min(1).max(40).default("roll-2x2"),
  item_ids: z.array(z.string().uuid()).optional(),
});

printRouter.post(
  "/render",
  asyncHandler(async (req, res) => {
    const parsed = RenderBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const { size_key, item_ids } = parsed.data;

    const db = tenantDb(req);
    const session = sessionUser(req);
    let q = db.selectFrom("labels_queue").selectAll().where("user_id", "=", session.id);
    if (item_ids && item_ids.length) q = q.where("id", "in", item_ids);
    const rows = await q.orderBy("created_at").execute();
    if (rows.length === 0) {
      res.status(400).json({ error: { code: "empty_queue", message: "No labels to print." } });
      return;
    }

    // Queue row → renderer item, expanded by qty. description is the label
    // text; qr_payload is the URL the QR encodes.
    const items: PrintItem[] = [];
    rows.forEach((r, i) => {
      for (let n = 0; n < (r.qty ?? 1); n++) {
        items.push({ kind: r.entity_type, id: i + 1, title: r.description, url: r.qr_payload });
      }
    });

    try {
      const { pdf, sheets } = await renderLabelsPdf({ size_key, items });
      res.json({ pdf_base64: pdf.toString("base64"), sheets, labels: items.length });
    } catch (e) {
      res.status(400).json({ error: { code: "render_failed", message: (e as Error).message } });
    }
  }),
);

printRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const session = sessionUser(req);
    const ctx = tenantContext(req);

    const items = await db
      .selectFrom("labels_queue")
      .selectAll()
      .where("user_id", "=", session.id)
      .orderBy("created_at")
      .execute();
    if (items.length === 0) {
      res.status(400).json({ error: { code: "empty_queue", message: "Queue is empty" } });
      return;
    }

    // Snapshot in one transaction so a half-cleared queue can't
    // happen if the client retries.
    const batchId = await db.transaction().execute(async (trx) => {
      const batch = await trx
        .insertInto("labels_batches")
        .values({ user_id: session.id, printed_at: new Date() })
        .returning("id")
        .executeTakeFirstOrThrow();
      for (const it of items) {
        await trx
          .insertInto("labels_prints")
          .values({
            batch_id: batch.id,
            module_name: it.module_name,
            entity_type: it.entity_type,
            entity_id: it.entity_id,
            qr_payload: it.qr_payload,
            description: it.description,
            qty: it.qty,
          })
          .execute();
      }
      await trx
        .deleteFrom("labels_queue")
        .where("user_id", "=", session.id)
        .execute();
      return batch.id;
    });

    // Render QR SVGs for each item. Expanded by qty (one printable
    // per copy) so the UI just iterates and prints. SVGs are tiny;
    // doing N renders in a row is fine for queues up to a few
    // hundred items.
    const printables: { description: string; qr_svg: string }[] = [];
    for (const it of items) {
      const svg = await qrSvg(it.qr_payload, { margin: 1 });
      for (let i = 0; i < it.qty; i++) {
        printables.push({ description: it.description, qr_svg: svg });
      }
    }

    platform().events.emit("labels.print.completed", {
      orgId: ctx.org.id,
      batchId,
      count: printables.length,
    });

    res.json({ batch_id: batchId, count: printables.length, printables });
  }),
);
