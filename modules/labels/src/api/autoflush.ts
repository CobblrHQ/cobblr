// Accumulate-then-print: the per-user policy config + the on-insert evaluator
// (slice 2, D5/D6/D9). On each queue add the handler calls evaluateAutoflush; a
// non-manual policy renders the due labels, snapshots a re-printable batch, clears
// them from the queue, and enqueues a background dispatch to core-print. A runaway
// guard (per-user cooldown + a hard per-fire cap) keeps a bad count or a loop from
// spewing labels with no human watching.

import { Router } from "express";
import { z } from "zod";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { sessionUser, tenantContext, tenantDb, type LabelsDB } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { renderRowsToPdf, customSheetFor } from "../print/render-queue.js";
import { findSize } from "../print/layout.js";
import { liveQrUrl } from "../live-qr-url.js";
import { flushDecision, type FireMode, type FlushPolicy } from "../flush-policy.js";

export const autoflushRouter = Router({ mergeParams: true });

// The core-print background dispatch queue + payload. A string contract, not an
// import (core-print owns its module) — mirrors knowing an event name. Kept in
// sync with modules/core-print/src/dispatch-worker.ts (DISPATCH_QUEUE / DispatchPayload).
const DISPATCH_QUEUE = "core-print.dispatch";

// Runaway guard: never fire more than once per this window per user, and never
// more than this many labels in one fire, no matter what the policy computes.
const COOLDOWN_MS = 3000;
const MAX_PER_FIRE = 200;

const FIRE_MODES = ["manual", "fill-media", "count", "immediate"] as const;

interface AutoflushRow {
  user_id: string;
  enabled: boolean;
  printer_id: string | null;
  size_key: string | null;
  fire_mode: string;
  fire_count: number;
  client_fired: boolean;
  last_fired_at: Date | null;
}

function present(row: AutoflushRow | undefined) {
  return {
    enabled: row?.enabled ?? false,
    printer_id: row?.printer_id ?? null,
    size_key: row?.size_key ?? null,
    fire_mode: (row?.fire_mode ?? "manual") as FireMode,
    fire_count: row?.fire_count ?? 2,
    // A Bluetooth printer's policy fires in the browser (slice 3c), not the server.
    client_fired: row?.client_fired ?? false,
  };
}

autoflushRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req)
      .selectFrom("labels_autoflush")
      .selectAll()
      .where("user_id", "=", sessionUser(req).id)
      .executeTakeFirst();
    res.json(present(row as AutoflushRow | undefined));
  }),
);

const PutBody = z.object({
  enabled: z.boolean(),
  printer_id: z.string().max(120).nullable().optional(),
  size_key: z.string().max(80).nullable().optional(),
  fire_mode: z.enum(FIRE_MODES),
  fire_count: z.number().int().min(1).max(MAX_PER_FIRE).default(2),
  // Bluetooth printers are fired from the browser (slice 3c); the server skips them.
  client_fired: z.boolean().default(false),
});

// AI-REACH: workspace configuration; the assistant changes config only through a workspace-scoped action, so a route with no action stays a person's
autoflushRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const d = parsed.data;
    // An enabled, non-manual policy must name a printer, else it can never fire. A
    // server-fired policy also needs a size (to render the sheet); a client-fired
    // (Bluetooth) policy doesn't — the browser owns its media + n-up tiling.
    if (d.enabled && d.fire_mode !== "manual") {
      const missing = !d.printer_id ? "a printer" : !d.client_fired && !d.size_key ? "a label size" : null;
      if (missing) {
        res.status(400).json({ error: { code: "incomplete", message: `Auto-print needs ${missing}.` } });
        return;
      }
    }
    const userId = sessionUser(req).id;
    const values = {
      user_id: userId,
      enabled: d.enabled,
      printer_id: d.printer_id ?? null,
      size_key: d.size_key ?? null,
      fire_mode: d.fire_mode,
      fire_count: d.fire_count,
      client_fired: d.client_fired,
      updated_at: new Date(),
    };
    await tenantDb(req)
      .insertInto("labels_autoflush")
      .values(values as never)
      .onConflict((oc) => oc.column("user_id").doUpdateSet(values as never))
      .execute();
    res.json(present(values as unknown as AutoflushRow));
  }),
);

export interface AutoflushFired {
  fired: true;
  count: number;
  batch_id: string;
  job_id: string;
}

/** Evaluate the user's auto-flush policy after a label is queued. Returns the fire
 *  result, or null when nothing fired (manual/disabled/threshold-not-met/cooldown).
 *  Takes the pieces (not a Request) so BOTH the /queue route AND the labels:print
 *  action handler can call it — any label reaching the buffer gets evaluated.
 *  `base` is the workspace QR base URL (from qrBaseFor at the route; null off a
 *  background action, where the rows' stored payloads are used as-is).
 *  Best-effort: callers wrap this so an auto-flush error never fails the queue. */
export async function evaluateAutoflush(
  db: Kysely<LabelsDB>,
  orgId: string,
  userId: string,
  base: string | null,
): Promise<AutoflushFired | null> {
  const cfg = (await db
    .selectFrom("labels_autoflush")
    .selectAll()
    .where("user_id", "=", userId)
    .executeTakeFirst()) as AutoflushRow | undefined;

  if (!cfg || !cfg.enabled || cfg.fire_mode === "manual") return null;
  // A client-fired (Bluetooth) policy accumulates + fires in the browser — the
  // server can't reach a BLE printer. Skip it here; the client loop owns the whole
  // accumulate → n-up compose → BLE fire → clear (slice 3c). The queue keeps
  // buffering until the client fires it.
  if (cfg.client_fired) return null;
  if (!cfg.printer_id || !cfg.size_key) return null;
  // Cooldown: a burst of scans must not fire a print per scan.
  if (cfg.last_fired_at && Date.now() - new Date(cfg.last_fired_at).getTime() < COOLDOWN_MS) return null;

  // Resolve the size to tiles-per-sheet + whether a partial sheet wastes tiles
  // (fixed-position laser sheet) or feeds only what's used (continuous roll).
  const sheet = cfg.size_key.startsWith("custom:") ? await customSheetFor(db, cfg.size_key) : findSize(cfg.size_key);
  if (!sheet) return null;
  const tiles = sheet.cols * sheet.rows;
  const fixedPositions = !!sheet.is_sheet_label;

  const buffered = Number(
    (await db.selectFrom("labels_queue").select((eb) => eb.fn.countAll().as("n")).where("user_id", "=", userId).executeTakeFirst())?.n ?? 0,
  );

  const policy: FlushPolicy = { mode: cfg.fire_mode as FireMode, count: cfg.fire_count };
  const decision = flushDecision(buffered, tiles, policy, { fixedPositions });
  if (decision.flush < 1) return null;
  const flush = Math.min(decision.flush, MAX_PER_FIRE);

  // The oldest `flush` rows (FIFO). fill-media leaves the remainder buffered.
  const rows = await db
    .selectFrom("labels_queue")
    .select(["id", "module_name", "entity_type", "entity_id", "qr_payload", "description", "qty"])
    .where("user_id", "=", userId)
    .orderBy("created_at")
    .limit(flush)
    .execute();
  if (rows.length === 0) return null;

  // Render FIRST — if it throws, nothing is deleted or dispatched. markPrinted:
  // these labels ARE auto-printed (a batch is recorded below), so freeze the
  // prefixes — unlike a bare preview render, which must not.
  const rendered = await renderRowsToPdf(db, orgId, base, rows as never, cfg.size_key, { markPrinted: true });

  // Snapshot a re-printable batch, clear the flushed rows, stamp the cooldown — one
  // tenant transaction so a crash can't half-clear the queue.
  const batchId = await db.transaction().execute(async (trx) => {
    const batch = await trx.insertInto("labels_batches").values({ user_id: userId, printed_at: new Date() } as never).returning("id").executeTakeFirstOrThrow();
    for (const it of rows) {
      await trx
        .insertInto("labels_prints")
        .values({ batch_id: batch.id, module_name: it.module_name, entity_type: it.entity_type, entity_id: it.entity_id, qr_payload: liveQrUrl(it.qr_payload, base), description: it.description, qty: it.qty } as never)
        .execute();
    }
    await trx.deleteFrom("labels_queue").where("id", "in", rows.map((r) => r.id)).where("user_id", "=", userId).execute();
    await trx.updateTable("labels_autoflush").set({ last_fired_at: new Date() } as never).where("user_id", "=", userId).execute();
    return batch.id as string;
  });

  // Hand the rendered PDF to core-print's durable dispatch queue (retry/backoff free).
  const jobId = await platform().queue.enqueue({
    orgId,
    queue: DISPATCH_QUEUE,
    payload: {
      printerId: cfg.printer_id,
      documentBase64: rendered.pdf.toString("base64"),
      filename: "labels.pdf",
      contentType: "application/pdf",
      jobName: `auto-flush ${rendered.labels} label(s)`,
    },
  });

  return { fired: true, count: rendered.labels, batch_id: batchId, job_id: jobId };
}
