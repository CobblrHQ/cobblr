// /print — snapshot the current queue into a batch + per-item
// prints, then clear the queue. Returns the rendered batch with QR
// SVGs so the client can drop them straight into a print preview.

import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { Router, type Request } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { qrSvg } from "./qr.js";
import { liveQrUrl } from "../live-qr-url.js";
import { SIZES } from "../print/layout.js";
import { renderRowsToPdf } from "../print/render-queue.js";
import { planRecord } from "../print/record-sent.js";
import { assignCodes, freezePrintedGroups, getOverlayForRefs } from "../services/codes.js";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";

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
    const r = await apiFetch(
      `${selfOrigin()}/api/v1/orgs/${encodeURIComponent(slug)}/modules/labels/qr/settings`,
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
  // Rendered to be sent to a printer now: the codes it draws are on paper from
  // this moment, so their groups are locked here, not when the batch is
  // confirmed, and a code sent to a printer is never handed to another record
  // while its confirmation waits (#7884).
  send: z.boolean().optional(),
});

// AI-REACH: exempt — renders label images for the person's browser or printer
// to print (and, for a send, locks the codes it drew). The assistant queues labels through labels:print
printRouter.post(
  "/render",
  asyncHandler(async (req, res) => {
    const parsed = RenderBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const { size_key, item_ids, send } = parsed.data;

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
      const { pdf, sheets, warnings, labels } = await renderRowsToPdf(db, org.id, base, rows as never, size_key, { markPrinted: send === true });
      // Each row and its copies as rendered: a send of this PDF records exactly these (#7593).
      res.json({ pdf_base64: pdf.toString("base64"), sheets, labels, rendered: rows.map((r) => ({ id: r.id, qty: r.qty })), warnings });
    } catch (e) {
      res.status(400).json({ error: { code: "render_failed", message: (e as Error).message } });
    }
  }),
);

// AI-ACTION: labels:print
printRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "labels:print"))) return;
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
    // Per-group: an instance can opt its code out of the QR center (default on),
    // resolved per entity via its code group with the kind default as fallback.
    const overlay = await getOverlayForRefs(db, printRefs);
    const printables: { description: string; qr_svg: string; center_code?: string }[] = [];
    for (const it of items) {
      const overlayOn = overlay.get(it.entity_id) ?? true;
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
  // The send this confirms, minted when it went to the printer: the same
  // confirmation twice records it once.
  send_id: z.string().uuid(),
  // The queue rows the CLIENT put on paper, each with the copies it SENT: a row
  // can change between Send and confirm, and the paper holds what was sent (#7593).
  items: z.array(z.object({ id: z.string().min(1).max(120), qty: z.number().int().min(1).max(1000) })).min(1).max(500),
});

// POST /print/record — bookkeeping for a print the SERVER did not perform.
//
// A browser-Bluetooth printer has no network address, so the browser prints it
// (see printBatchOverBluetooth) and the server never sees the job. Without this,
// those rows stayed in the queue looking unprinted, nothing landed in history,
// and their codes were never frozen — so a queue printed over Bluetooth invited
// a second press and a second roll of labels.
//
// Deliberately takes the rows that actually printed rather than clearing the
// whole queue: a partial batch (printer jammed at row 7) must leave the
// unprinted rows queued. And each with the copies that were sent, not the
// row's count now: copies raised from three to five while the confirmation
// was open are two nobody printed, and recording the row by id alone took
// them too (#7593). The paper is the source of truth, so this records what
// physically exists and keeps the rest queued. A body of bare ids is an older
// page that cannot say what it sent: refused, nothing recorded.
// AI-REACH: exempt — the print path reporting which labels physically came out
// of the printer; only the printer's side knows, and the paper is the truth
printRouter.post(
  "/record",
  asyncHandler(async (req, res) => {
    if (req.body && typeof req.body === "object" && "item_ids" in req.body && !("items" in req.body)) {
      res.status(400).json({ error: { code: "reload_to_record", message: "This page is out of date and cannot say which copies it printed. Reload it, then mark the batch printed again. Nothing was recorded." } });
      return;
    }
    const parsed = RecordPrinted.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const session = sessionUser(req);
    const ctx = tenantContext(req);
    const base = await qrBaseFor(req);

    // Read, decide and write in one transaction with the rows locked, so a copy
    // count changed while this runs is either all before it or all after.
    const done = await db.transaction().execute(async (trx) => {
      // Scope to this user's own rows: an id from another session must not let
      // someone clear a queue that isn't theirs.
      const items = await trx
        .selectFrom("labels_queue")
        .selectAll()
        .where("user_id", "=", session.id)
        .where("id", "in", parsed.data.items.map((i) => i.id))
        .orderBy("created_at")
        .forUpdate()
        .execute();
      const plan = planRecord(items, parsed.data.items);
      // Already recorded (a retry, or a double submit). Not an error: the
      // labels exist either way and the caller wants the queue clean. The
      // send's unique index decides a repeat: its batch is never inserted twice.
      if (plan.printed.length === 0) return null;
      const batch = await trx
        .insertInto("labels_batches")
        .values({ user_id: session.id, printed_at: new Date(), send_id: parsed.data.send_id })
        .onConflict((oc) => oc.columns(["user_id", "send_id"]).where("send_id", "is not", null).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!batch) return null;
      const byId = new Map(items.map((it) => [it.id, it]));
      for (const p of plan.printed) {
        const it = byId.get(p.id)!;
        await trx
          .insertInto("labels_prints")
          .values({
            batch_id: batch.id,
            module_name: it.module_name,
            entity_type: it.entity_type,
            entity_id: it.entity_id,
            qr_payload: liveQrUrl(it.qr_payload, base),
            description: it.description,
            qty: p.qty,
          })
          .execute();
      }
      for (const k of plan.keep) {
        await trx.updateTable("labels_queue").set({ qty: k.qty }).where("user_id", "=", session.id).where("id", "=", k.id).execute();
      }
      if (plan.remove.length) {
        await trx.deleteFrom("labels_queue").where("user_id", "=", session.id).where("id", "in", plan.remove).execute();
      }
      return { batchId: batch.id, plan, items };
    });
    if (!done) {
      res.json({ batch_id: null, recorded: 0 });
      return;
    }
    const { batchId, plan, items } = done;

    // Same guarantee as the server path: a printed sticker cannot change, so
    // lock the prefixes these labels used.
    const printed = new Set(plan.printed.map((p) => p.id));
    const printRefs = items.filter((it) => printed.has(it.id)).map((it) => ({ kind: `${it.module_name}:${it.entity_type}`, id: it.entity_id }));
    await freezePrintedGroups(db, printRefs);

    platform().events.emit("labels.print.completed", {
      orgId: ctx.org.id,
      batchId,
      count: plan.printed.reduce((n, p) => n + p.qty, 0),
    });

    res.json({ batch_id: batchId, recorded: plan.printed.length });
  }),
);
