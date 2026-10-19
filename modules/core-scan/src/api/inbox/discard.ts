// Discard and restore, a scan as a receipt, and the receipt field backfill.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { requireCapability } from "@cobblr/platform-contract/action-gate";
import { type Request } from "express";
import { z } from "zod";
import { orderLines, deleteReceiptOrder } from "../../services/receipt-order.js";
import { platform } from "@cobblr/platform-contract";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { asyncHandler, requireRole } from "../util.js";
import { filingDestination, type DestinationRow } from "../../services/destination.js";
import { scanDeletedRecovery, scanRestoreRefusal } from "@cobblr/platform-contract/scan-recovery";
import { routeScannedReceiptPhoto } from "../../services/receipt-photo.js";
import { runReceiptBackfill } from "../../services/receipt-backfill.js";
import { INTERNAL_API, destinationTablesFor, liveTablesFor, served, titleFormatFor, withTitle } from "./shared.js";

export const discardRouter = Router({ mergeParams: true });

// ── Fill fields from receipts already filed ──────────────────────────────────
// The other half of receipt-record.ts: everything a parse established is kept
// on the item whether or not a field claimed it, so when the field arrives the
// answers can move into it. Explicit on purpose - switching a setting on should
// not rewrite months of items behind your back.
// AI-ACTION: core-scan:fill-fields-from-receipts
// AI-REACH: action core-scan:fill-fields-from-receipts
discardRouter.post(
  "/receipts/backfill-fields",
  asyncHandler(async (req, res) => {
    if (!(await requireCapability(req, res, "core-scan:fill-fields-from-receipts"))) return;
    const result = await runReceiptBackfill(tenantContext(req).org.id, {
      dryRun: req.query.dry_run === "true",
    });
    res.json(result);
  }),
);

// ─────────────────────── POST /inbox/:id/discard ──────────────────

// AI-TOOL: change_scan_item
discardRouter.post(
  "/inbox/:id/discard",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const expected = z.object({ kind: z.string(), id: z.string() }).optional().parse(req.body?.expected_container);
    const row = await db
      .updateTable("core_scan_inbox_items")
      .set({ status: "discarded", updated_at: new Date() })
      .where("id", "=", id)
      .$if(!!expected, (q) => q.where("status", "=", "pending")
        .where("target_container_kind", "=", expected!.kind).where("target_container_id", "=", expected!.id))
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    // The receipt's LAST live line just went. Its order was created eagerly at
    // parse (order-at-parse.md), so without this an abandoned receipt leaves a
    // purchase behind — a cost that did not exist while orders were born at
    // confirm, and the reason cancelling is part of that change rather than a
    // follow-up. DELETED when no line was ever claimed: the order was made by
    // a parse nobody kept, and a session is deleted because the read went wrong
    // and a better picture is coming, which will make its own order - a
    // cancelled ghost beside it is clutter (the operator, 2026-09-06). A line
    // somebody DID claim means the order is real, and this path is never
    // reached for it: a filed line is resolved, not discarded, so it is live.
    // Done before the discard answers: a discard that said done while the
    // order was still there let the order outlive the person's own next look,
    // and a failure here went unseen forever (#5046).
    if (row.scan_batch_id) {
      await (async () => {
        try {
          const live = await db
            .selectFrom("core_scan_inbox_items")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("scan_batch_id", "=", row.scan_batch_id)
            .where("status", "!=", "discarded")
            .executeTakeFirst();
          if (Number(live?.n ?? 0) > 0) return;
          const batch = await db
            .selectFrom("core_scan_batches")
            .select("purchases_order_id")
            .where("id", "=", row.scan_batch_id!)
            .executeTakeFirst();
          if (!batch?.purchases_order_id) return;
          const oargs = {
            baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
            slug: ctx.org.slug,
            headers: { Authorization: `Bearer ${bearer(req)}`, "Content-Type": "application/json" },
            orderId: batch.purchases_order_id,
          };
          // Belt and braces on "nobody claimed a line": read the order itself.
          const lines = await orderLines(oargs);
          if (lines === null || lines.some((l) => l.part_id)) return;
          await deleteReceiptOrder(oargs);
        } catch (err) {
          console.warn("[core-scan] discard order cancel threw:", (err as Error).message);
        }
      })();
    }
    void platform().events.emit("core-scan.scan.discarded", {
      orgId: ctx.org.id,
      itemId: id,
    });
    res.json(await served(req, row));
  }),
);

// ─────────────────────── POST /inbox/:id/restore ──────────────────
// Un-discard a soft-deleted scan back into the pending queue (the "recently
// deleted" undo). Only acts on a discarded row; its enriched data was preserved
// by the soft delete, so it comes back exactly as it left.
// AI-TOOL: change_scan_item
discardRouter.post(
  "/inbox/:id/restore",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    // A combine-loser's quantity was SUMMED into its primary — restoring it
    // would double-count (and the primary's merged_barcodes would go stale).
    // Refuse with a pointer at the primary; splitting there is the honest way
    // to get a separate row back.
    const pre = await db
      .selectFrom("core_scan_inbox_items")
      .select(["suggested_metadata"])
      .where("id", "=", id)
      .where("status", "=", "discarded")
      .executeTakeFirst();
    // A combined row's quantity lives in the row it joined, and a piece of an
    // undone split lives in the group photo: restoring either alone would
    // count the thing twice. The refusal names the way back the row itself
    // offers (scan-recovery.ts), never an action that is not on screen.
    const recovery = scanDeletedRecovery(pre?.suggested_metadata as Record<string, unknown> | null);
    const refusal = scanRestoreRefusal(recovery);
    if (refusal) {
      res.status(409).json({
        error: {
          code: recovery.kind === "undo_combine" ? "was_combined" : "split_undone",
          message: refusal,
          recovery,
          ...(recovery.kind === "undo_combine" ? { combined_into: recovery.into } : { split_from: recovery.kind === "in_group_photo" ? recovery.from : null }),
        },
      });
      return;
    }
    const row = await db
      .updateTable("core_scan_inbox_items")
      // created_at is PRESERVED — a restore is an UNDO, and the item goes back
      // exactly where it was (same contract as un-confirm). Bumping created_at
      // to "requeue at the top" yanked the item AND its whole session group to
      // the top of the inbox on an accidental-X-then-undo, and rewrote the
      // item's real scan time. The "find it later" case (restoring from
      // Recently deleted long after) is handled client-side by highlight +
      // scroll-to, never by a created_at rewrite.
      .set({ status: "pending", updated_at: new Date() })
      .where("id", "=", id)
      .where("status", "=", "discarded")
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "discarded inbox item not found" } });
      return;
    }
    res.json(await served(req, row));
  }),
);

/** The kind a row will be filed as ("groceries:item"), from the same one
 *  destination the card shows, spelled as the workspace's tables spell it so
 *  it compares with the kinds records live under. Null when it has none. */
export async function filingKindFor(row: DestinationRow, req: Request): Promise<string | null> {
  const tables = await destinationTablesFor(req);
  const d = filingDestination(row, tables, await liveTablesFor(req));
  if (!d) return null;
  if (typeof d.kind === "string" && d.kind) return d.kind;
  const table = tables.find((t) => t.module_name === d.module && t.instance_name === (d.instance ?? d.module));
  return typeof table?.kind === "string" && table.kind ? table.kind : null;
}

/** The requesting person's title format, for withTitle. */
/** The name a card shows for a row, composed on the way out (the person's
 *  own name, a titled work in their format, a colour suffix). Anything that
 *  remembers a row's name to compare against the card later, like a put-away
 *  plan, stores THIS: storing the raw column read every coloured spool as
 *  "changed since this plan", through any number of re-plans (#4024). */
export function servedItemName(row: Parameters<typeof withTitle>[0], req: Request): string | null {
  return withTitle(row, new Set(), titleFormatFor(req)).suggested_name;
}


// ─────────────────────── POST /inbox/:id/as-receipt ───────────────
//
// "That is a receipt." The intake's identify step routes a photographed receipt
// to the receipt parser on its own verdict (handlers.ts, enrich-photo's
// `is-receipt`), so nobody is asked photo-or-receipt on the way in (#2882).
// When that verdict misses, this is the one-tap correction from the card: the
// photo goes to the same receipt parser the dedicated upload uses (one code
// path: batch, lines, review before filing, the purchases order), and the
// photo row is retired the way a detected receipt's is. No identify call.
// AI-REACH: exempt (scan-inbox correction a person taps with the photo in view; the assistant reaches the receipt parser through scan/receipt and repairs a stored verdict through rerun-ai)
discardRouter.post(
  "/inbox/:id/as-receipt",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["id", "image_file_id", "status"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    if (!row.image_file_id) {
      res.status(422).json({ error: { code: "no_photo", message: "This item has no photo to read as a receipt." } });
      return;
    }
    // `force`: the person says this is a second copy of a receipt already in.
    const force = (req.body as { force?: unknown } | undefined)?.force === true;
    const routed = await routeScannedReceiptPhoto({
      orgId: ctx.org.id,
      itemId: id,
      fileId: row.image_file_id,
      userId: sessionUser(req).id,
      ...(force ? { force: true } : {}),
    });
    if (!routed.routed) {
      // A receipt already in is not "not a receipt"; the code says which.
      const code = routed.failure === "already_imported" ? "already_imported" : "not_a_receipt";
      res.status(422).json({ error: { code, message: routed.note, ...(routed.failure ? { failure: routed.failure } : {}), ...(routed.ai ? { ai: routed.ai } : {}) } });
      return;
    }
    res.json({ ok: true, receipt: true, items: routed.items });
  }),
);
