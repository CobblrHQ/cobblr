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
import { SIZES } from "../print/layout.js";
import { renderRowsToPdf } from "../print/render-queue.js";
import { assignCodes, freezePrintedGroups, getOverlayCenter } from "../services/codes.js";

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

// The workspace's custom label base URL lives in the QR settings (same
// module), read over a loopback to its settings endpoint (same pattern
// scan-drive uses). Lets us rebuild each queued label's URL against the CURRENT
// base at print time, so what prints matches the live preview. Null on any
// failure → labels keep their stored URL.
export async function qrBaseFor(req: Request): Promise<string | null> {
  try {
    const slug = req.params.slug;
    if (!slug) return null;
    const auth = req.headers.authorization;
    const port = process.env.API_PORT ?? "4000";
    const r = await fetch(
      `http://127.0.0.1:${port}/api/v1/orgs/${encodeURIComponent(slug)}/modules/labels/qr/settings`,
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
  // 80 chars: a workspace size is `custom:<uuid>` (43), longer than any preset key.
  size_key: z.string().min(1).max(80).default("roll-2x2"),
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
    const { org } = tenantContext(req);
    let q = db
      .selectFrom("labels_queue")
      .select(["id", "module_name", "entity_type", "entity_id", "qr_payload", "description", "qty"])
      .where("user_id", "=", session.id);
    if (item_ids && item_ids.length) q = q.where("id", "in", item_ids);
    const rows = await q.orderBy("created_at").execute();
    if (rows.length === 0) {
      res.status(400).json({ error: { code: "empty_queue", message: "No labels to print." } });
      return;
    }

    try {
      const base = await qrBaseFor(req);
      const { pdf, sheets, warnings, labels } = await renderRowsToPdf(db, org.id, base, rows as never, size_key);
      res.json({ pdf_base64: pdf.toString("base64"), sheets, labels, warnings });
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
    const printRefs = items.map((it) => ({ kind: `${it.module_name}:${it.entity_type}`, id: it.entity_id }));
    const codes = await assignCodes(ctx.org.id, db, printRefs);
    // A batch is recorded — these labels exist. Lock their prefixes.
    await freezePrintedGroups(db, printRefs);
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

const RecordPrinted = z.object({
  // Queue row ids the CLIENT has already put on paper.
  item_ids: z.array(z.string().min(1).max(120)).min(1).max(500),
});

// POST /print/record — bookkeeping for a print the SERVER did not perform.
//
// A browser-Bluetooth printer has no network address, so the browser prints it
// (see printBatchOverBluetooth) and the server never sees the job. Without this,
// those rows stayed in the queue looking unprinted, nothing landed in history,
// and their codes were never frozen — so a queue printed over Bluetooth invited
// a second press and a second roll of labels.
//
// Deliberately takes the ids that actually printed rather than clearing the
// whole queue: a partial batch (printer jammed at row 7) must leave the
// unprinted rows queued. The paper is the source of truth, so this records what
// physically exists and forgets the rest.
printRouter.post(
  "/record",
  asyncHandler(async (req, res) => {
    const parsed = RecordPrinted.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const session = sessionUser(req);
    const ctx = tenantContext(req);
    const base = await qrBaseFor(req);

    // Scope to this user's own rows: an id from another session must not let
    // someone clear a queue that isn't theirs.
    const items = await db
      .selectFrom("labels_queue")
      .selectAll()
      .where("user_id", "=", session.id)
      .where("id", "in", parsed.data.item_ids)
      .orderBy("created_at")
      .execute();
    if (items.length === 0) {
      // Already recorded (a retry, or a double submit). Not an error: the
      // labels exist either way and the caller wants the queue clean.
      res.json({ batch_id: null, recorded: 0 });
      return;
    }

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
        .where(
          "id",
          "in",
          items.map((i) => i.id),
        )
        .execute();
      return batch.id;
    });

    // Same guarantee as the server path: a printed sticker cannot change, so
    // lock the prefixes these labels used.
    const printRefs = items.map((it) => ({ kind: `${it.module_name}:${it.entity_type}`, id: it.entity_id }));
    await freezePrintedGroups(db, printRefs);

    platform().events.emit("labels.print.completed", {
      orgId: ctx.org.id,
      batchId,
      count: items.reduce((n, it) => n + (it.qty ?? 1), 0),
    });

    res.json({ batch_id: batchId, recorded: items.length });
  }),
);
