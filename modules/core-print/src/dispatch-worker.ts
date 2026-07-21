// A core-queue worker that dispatches a document to a printer in the BACKGROUND —
// the server-side firing path for label auto-flush (D8). A content module (labels)
// renders a PDF and enqueues it here; this worker prints it with the kernel's
// retry/backoff for free. Modeled on digifab's poll-worker: registerWorker at boot,
// platform().tenants.getDb(orgId) for tenant access.

import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CorePrintDB } from "./db.js";
import { dispatchToPrinter, loadPrinterRow } from "./dispatch.js";

export const DISPATCH_QUEUE = "core-print.dispatch";

/** What an enqueued print job carries. `documentBase64` is the rendered bytes
 *  (a PDF for CUPS); the printer is named by id so the worker reads the live row. */
export interface DispatchPayload {
  printerId: string;
  documentBase64: string;
  filename?: string;
  contentType?: string;
  jobName?: string;
  copies?: number;
}

let registered = false;

export function registerDispatchWorker(): void {
  if (registered) return;
  registered = true;
  platform().queue.registerWorker(DISPATCH_QUEUE, async (job) => {
    const p = job.payload as unknown as DispatchPayload;
    // Malformed payload can never succeed — drop it rather than burn 3 retries.
    if (!p?.printerId || typeof p.documentBase64 !== "string") {
      console.error(`[core-print:dispatch] job ${job.id} has no printerId/document — dropping`);
      return;
    }
    const db = (await platform().tenants.getDb(job.orgId)) as Kysely<CorePrintDB>;
    const row = await loadPrinterRow(db, p.printerId);
    if (!row) {
      // The printer was deleted between enqueue and run. No point retrying.
      console.error(`[core-print:dispatch] job ${job.id}: printer ${p.printerId} gone — dropping`);
      return;
    }
    const doc = {
      bytes: new Uint8Array(Buffer.from(p.documentBase64, "base64")),
      filename: p.filename ?? "label.pdf",
      contentType: p.contentType ?? "application/pdf",
    };
    // Throw on a dispatch failure so the queue retries with backoff (default 3
    // attempts); dispatchToPrinter has already emitted core-print.job.failed for
    // observers. After the last attempt the job sits 'failed' (logged by core-queue).
    await dispatchToPrinter(job.orgId, row, doc, { copies: p.copies, jobName: p.jobName });
  });
}

/** Enqueue a document for durable, retried background printing. Returns the job id.
 *  The on-brand way for a content module to print without reaching into core-print:
 *  it renders bytes and hands them to the printing capability's queue. */
export async function enqueueDispatch(orgId: string, payload: DispatchPayload): Promise<string> {
  return platform().queue.enqueue({
    orgId,
    queue: DISPATCH_QUEUE,
    payload: payload as unknown as Record<string, unknown>,
  });
}
