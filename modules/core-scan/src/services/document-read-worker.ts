// A document that waited for the document model (#4571).
//
// When a check on the engine's read of a page failed and every document
// model was busy, the item was filed from the engine's read with the doubtful
// fields marked, and a job was queued here. The job asks the document model
// again on a backoff; when one answers, its read goes through the same reader
// and the same checks (document-read.ts), and only a read that fails fewer
// checks than what the item has replaces it. The item is never read by a
// weaker model in the meantime: that is the capability's own rule.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { documentImages } from "@cobblr/platform-contract/document-images";
import type { CoreScanDB } from "../db.js";
import { readBillOfSale } from "./bill-of-sale.js";
import { checkAndSettle, readPageWithDocumentModel } from "./document-read.js";
import { fieldsToCheck } from "./document-checks.js";
import { mergeMeta } from "./metadata.js";
import { restampTrackedMatch } from "./tracked-stamp.js";
import { readPersonalDocumentLocally } from "./personal-document.js";

export const DOCUMENT_READ_QUEUE = "core-scan.document-read";
/** Five minutes, doubling to half an hour: a busy model usually frees inside
 *  the hour, and the person has the engine's read to work with meanwhile. */
const DELAYS_MS = [5, 10, 20, 30, 30, 30, 30, 30].map((m) => m * 60_000);
/** An allowance used up for the day comes back the next day: hourly, for a
 *  day and a bit (#4633). */
const LIMIT_DELAYS_MS = Array.from({ length: 26 }, () => 60 * 60_000);

export async function enqueueDocumentRead(args: { orgId: string; itemId: string; attempt?: number; limit?: boolean }): Promise<void> {
  const attempt = args.attempt ?? 1;
  const delays = args.limit ? LIMIT_DELAYS_MS : DELAYS_MS;
  await platform().queue.enqueue({
    orgId: args.orgId,
    queue: DOCUMENT_READ_QUEUE,
    payload: { itemId: args.itemId, attempt, ...(args.limit ? { limit: true } : {}) },
    runAt: new Date(Date.now() + (delays[attempt - 1] ?? delays[delays.length - 1]!)),
    maxAttempts: 2,
  });
}

/** The page the item came from: the batch's file, its first page image for a
 *  scanned PDF. */
async function pageOf(orgId: string, db: Kysely<CoreScanDB>, batchId: string | null): Promise<Buffer | null> {
  if (!batchId) return null;
  const batch = await db.selectFrom("core_scan_batches").select(["source_file_id"]).where("id", "=", batchId).executeTakeFirst();
  const fileId = (batch as { source_file_id?: string | null } | undefined)?.source_file_id;
  if (!fileId) return null;
  const file = await platform().files.read(orgId, fileId, "original");
  if (!file) return null;
  const bytes = Buffer.from(file.bytes);
  if ((await readPersonalDocumentLocally({ bytes, mime: file.mimeType })).privacy === "personal") return null;
  if (bytes.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    const images = await documentImages(new Uint8Array(bytes), { maxPages: 2, minSide: 300 });
    return images?.[0]?.png ? Buffer.from(images[0].png) : null;
  }
  return bytes;
}

export function registerDocumentReadWorker(): void {
  platform().queue.registerWorker(DOCUMENT_READ_QUEUE, async (job) => {
    const p = job.payload as { itemId?: unknown; attempt?: unknown; limit?: unknown };
    const itemId = typeof p.itemId === "string" ? p.itemId : "";
    const attempt = typeof p.attempt === "number" ? p.attempt : 1;
    if (!itemId) return;
    const db = (await platform().tenants.getDb(job.orgId)) as unknown as Kysely<CoreScanDB>;
    const row = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", itemId).executeTakeFirst();
    const meta = (row?.suggested_metadata ?? {}) as Record<string, unknown>;
    const waiting = (meta.check_fields as { waiting_for_ai?: boolean } | undefined)?.waiting_for_ai;
    // Filed, discarded, or checked by a person since: nothing left to read.
    if (!row || row.status !== "pending" || !waiting || meta.reviewed) return;
    const page = await pageOf(job.orgId, db, row.scan_batch_id ?? null);
    if (!page) return;
    const ai = await readPageWithDocumentModel(job.orgId, page, itemId, null);
    if (!ai.ok) {
      const limit = !!ai.limit;
      const room = limit ? LIMIT_DELAYS_MS.length : DELAYS_MS.length;
      // Waiting again, for the reason it is waiting now: the card says it.
      if ((ai.busy || limit) && attempt < room) {
        if (limit !== (p.limit === true)) {
          await db
            .updateTable("core_scan_inbox_items")
            .set({ suggested_metadata: mergeMeta({ check_fields: { ...(meta.check_fields as object), waiting_for_ai: true, ...(limit ? { waiting_reason: "limit" } : { waiting_reason: null }) } }) as never, updated_at: new Date() })
            .where("id", "=", itemId)
            .execute();
        }
        await enqueueDocumentRead({ orgId: job.orgId, itemId, attempt: limit === (p.limit === true) ? attempt + 1 : 1, limit });
      } else
        await db
          .updateTable("core_scan_inbox_items")
          .set({ suggested_metadata: mergeMeta({ check_fields: { ...(meta.check_fields as object), waiting_for_ai: false } }) as never, updated_at: new Date() })
          .where("id", "=", itemId)
          .execute();
      return;
    }
    const sale = readBillOfSale(ai.text);
    if (!sale) return;
    const settled = await checkAndSettle(job.orgId, sale, ai.text);
    const before = ((meta.check_fields as { fields?: string[] } | undefined)?.fields ?? []).length;
    const failed = fieldsToCheck(settled.verdict);
    if (failed.length > before) return;
    const unit = settled.receipt.items[0] as (typeof settled.receipt.items)[number] & {
      decoded?: { decoder_id: string; code: string; fields: Record<string, unknown> };
      facts?: Record<string, unknown>;
      manufacturer?: string | null;
      model?: string | null;
    };
    if (!unit) return;
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        suggested_name: unit.description.slice(0, 300),
        ...(unit.manufacturer ? { suggested_manufacturer: unit.manufacturer } : {}),
        ...(unit.decoded ? { barcode_text: unit.decoded.code } : {}),
        // Only the keys this read settles, onto the live row; a read that
        // passes everything takes the doubts away.
        suggested_metadata: mergeMeta(
          {
            ...(failed.length ? { check_fields: { fields: failed, why: settled.verdict.failed.map((f) => f.why) } } : {}),
            ...(unit.decoded ? { decoded: { decoder_id: unit.decoded.decoder_id, fields: unit.decoded.fields }, serial_number: unit.decoded.code } : {}),
            ...(unit.facts ? { line_facts: unit.facts } : {}),
            ...(unit.model ? { model: unit.model } : {}),
            parse_method: "ai-document",
          },
          failed.length ? [] : ["check_fields"],
        ) as never,
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();
    // The VIN now proved finds the vehicle the workspace already has.
    const fresh = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", itemId).executeTakeFirst();
    if (fresh) await restampTrackedMatch(job.orgId, db as never, itemId, fresh, null, null).catch(() => null);
  });
}
