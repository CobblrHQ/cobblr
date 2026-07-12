// /print — snapshot the current queue into a batch + per-item
// prints, then clear the queue. Returns the rendered batch with QR
// SVGs so the client can drop them straight into a print preview.

import { Router, type Request } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { qrSvg } from "./qr.js";
import { liveQrUrl } from "../live-qr-url.js";
import { renderLabelsPdf, type PrintItem } from "../print/pdf.js";
import { SIZES } from "../print/layout.js";
import { assignCodes, getOverlayCenter } from "../services/codes.js";

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

// The workspace's custom label base URL lives in core-labels-qr (a sibling
// module), read over a loopback to its settings endpoint (same pattern
// scan-drive uses). Lets us rebuild each queued label's URL against the CURRENT
// base at print time, so what prints matches the live preview. Null on any
// failure → labels keep their stored URL.
async function qrBaseFor(req: Request): Promise<string | null> {
  try {
    const slug = req.params.slug;
    if (!slug) return null;
    const auth = req.headers.authorization;
    const port = process.env.API_PORT ?? "4000";
    const r = await fetch(
      `http://127.0.0.1:${port}/api/v1/orgs/${encodeURIComponent(slug)}/modules/core-labels-qr/settings`,
      { headers: auth ? { authorization: auth } : {} },
    );
    if (!r.ok) return null;
    const s = (await r.json()) as { label_base_url?: string | null };
    return s.label_base_url ?? null;
  } catch {
    return null;
  }
}

// ── direct-to-printer (CUPS via core-print) ──────────────────────────
// Render the queue to a print-ready PDF with the print-sheet renderer
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
    const base = await qrBaseFor(req);
    // Get-or-assign a human-readable code (m1, p42, b7) per entity — the same
    // code is reused across a queue row's qty copies and across reprints.
    const ctx = tenantContext(req);
    const codes = await assignCodes(
      ctx.org.id,
      db,
      rows.map((r) => ({ kind: `${r.module_name}:${r.entity_type}`, id: r.entity_id })),
    );
    // Per-kind: some kinds opt out of the QR-center code (default on).
    const overlay = await getOverlayCenter(db, rows.map((r) => `${r.module_name}:${r.entity_type}`));
    const items: PrintItem[] = [];
    rows.forEach((r, i) => {
      const overlayOn = overlay.get(`${r.module_name}:${r.entity_type}`) ?? true;
      const centerCode = overlayOn ? codes.get(r.entity_id) : undefined;
      for (let n = 0; n < (r.qty ?? 1); n++) {
        items.push({ kind: r.entity_type, id: i + 1, title: r.description, url: liveQrUrl(r.qr_payload, base), centerCode });
      }
    });

    try {
      const { pdf, sheets, warnings } = await renderLabelsPdf({ size_key, items });
      res.json({ pdf_base64: pdf.toString("base64"), sheets, labels: items.length, warnings });
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
    // Resolve the live base once, and record the ACTUAL printed URL in history.
    const base = await qrBaseFor(req);

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
            qr_payload: liveQrUrl(it.qr_payload, base),
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
    // Assign a human-readable code per entity and draw it in the QR center;
    // bump those QRs to EC=H so the overlay stays scannable.
    const codes = await assignCodes(
      ctx.org.id,
      db,
      items.map((it) => ({ kind: `${it.module_name}:${it.entity_type}`, id: it.entity_id })),
    );
    // Per-kind: some kinds opt out of the QR-center code (default on).
    const overlay = await getOverlayCenter(db, items.map((it) => `${it.module_name}:${it.entity_type}`));
    const printables: { description: string; qr_svg: string; center_code?: string }[] = [];
    for (const it of items) {
      const overlayOn = overlay.get(`${it.module_name}:${it.entity_type}`) ?? true;
      const center_code = overlayOn ? codes.get(it.entity_id) : undefined;
      const svg = await qrSvg(liveQrUrl(it.qr_payload, base), { margin: 1, ecLevel: center_code ? "H" : "M" });
      for (let i = 0; i < it.qty; i++) {
        printables.push({ description: it.description, qr_svg: svg, center_code });
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
