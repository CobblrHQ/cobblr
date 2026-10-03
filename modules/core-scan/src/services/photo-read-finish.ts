// What happens after a photo's read, whoever ran it: the scan's own identify
// (api/handlers.ts) and a queued hosted identify that finished later
// (hosted-identify-job.ts). One copy, so an answer that arrives an hour late
// goes exactly where the same answer would have gone at once.

import { platform } from "@cobblr/platform-contract";
import type { EnrichOutcome } from "./enrich-photo.js";
import { routeScannedReceiptPhoto } from "./receipt-photo.js";

export type PhotoReadFinish =
  | { receipt: true; items: unknown }
  | { receipt: false; skipped: string }
  | { identified: true }
  | { queued: true };

export async function finishPhotoRead(args: {
  orgId: string;
  itemId: string;
  fileId: string;
  userId: string | null;
  outcome: EnrichOutcome;
  /** A queued hosted read that finished: the receipt door collects its
   *  answer instead of asking again (hosted-identify-job.ts). */
  hostedJobId?: string;
}): Promise<PhotoReadFinish> {
  // You photographed a receipt. Hand it to the receipt parser instead of
  // filing the paper as a thing you own — the same route an uploaded receipt
  // takes, so the batch, the line items and the purchases order are all
  // created by the one code path. No enriched event: nothing was identified,
  // and the lines raise their own.
  if (args.outcome === "is-receipt") {
    const r = await routeScannedReceiptPhoto({ orgId: args.orgId, itemId: args.itemId, fileId: args.fileId, userId: args.userId, ...(args.hostedJobId ? { hostedJobId: args.hostedJobId } : {}) });
    if (r.routed) return { receipt: true, items: r.items };
    // The read itself was queued at the hosted identify: its job finishes it.
    if (r.queued) return { queued: true };
    // Called it a receipt and could not read it. The row is still there,
    // with the reason on it (routeScannedReceiptPhoto wrote the note).
    return { receipt: false, skipped: r.reason };
  }
  // The answer is coming later: the job that brings it finishes the read.
  if (args.outcome === "identify-queued") return { queued: true };
  void platform().events.emit("core-scan.scan.enriched", { orgId: args.orgId, itemId: args.itemId });
  return { identified: true };
}
