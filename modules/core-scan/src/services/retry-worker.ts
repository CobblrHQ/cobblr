/** The core-queue worker that actually re-runs a throttled barcode look-up.
 *
 *  Separate from `retry-lookup.ts` on purpose: that module is imported BY
 *  `enrich.ts` (to enqueue), and this one imports `enrich.ts` (to run). Keeping
 *  the policy and the worker apart is what stops that being an import cycle. */

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";
import { enrichBarcodeItem } from "./enrich.js";
import { dropMeta, mergeMeta } from "./metadata.js";
import {
  RETRY_LOOKUP_QUEUE,
  RETRY_MAX_ATTEMPTS,
  enqueueRetryLookup,
  retriesExhausted,
  retryStep,
  type RetryCause,
} from "./retry-lookup.js";

interface RetryPayload {
  itemId?: unknown;
  upc?: unknown;
  orgSlug?: unknown;
  attempt?: unknown;
}

export function registerRetryLookupWorker(): void {
  platform().queue.registerWorker(RETRY_LOOKUP_QUEUE, async (job) => {
    const p = job.payload as RetryPayload;
    const itemId = typeof p.itemId === "string" ? p.itemId : "";
    const upc = typeof p.upc === "string" ? p.upc : "";
    const orgSlug = typeof p.orgSlug === "string" ? p.orgSlug : "";
    if (!itemId || !upc) return; // nothing actionable; do not retry a malformed job

    const db = (await platform().tenants.getDb(job.orgId)) as unknown as Kysely<CoreScanDB>;
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["suggested_name", "status"])
      .where("id", "=", itemId)
      .executeTakeFirst();
    // Discarded, or resolved in the meantime (a re-scan, a manual rename, the
    // user naming it themselves). Either way the promise has been kept and
    // there is nothing left to chase.
    if (!row || row.status === "discarded" || row.suggested_name) return;

    // The chain counts its own attempts (the payload), so it keeps its own
    // schedule. A job queued before that carried no count; core-queue's
    // pre-increment `attempts` is the same number for it (workerAttempt).
    const attemptNo = typeof p.attempt === "number" && p.attempt >= 1 ? p.attempt : job.attempts + 1;
    const lastChance = retriesExhausted(attemptNo, RETRY_MAX_ATTEMPTS);

    await enrichBarcodeItem({
      db,
      orgId: job.orgId,
      itemId,
      orgSlug,
      upc,
      // The rate-limited outcome was deliberately never cached, but force also
      // skips the tenant cache's stale miss if one landed since.
      force: true,
      fromRetryWorker: true,
      // A queued retry has no requesting user, so no user-scoped AI connection
      // resolves. That is correct rather than a limitation: this is the
      // workspace's background work, not a person's.
      userId: null,
    });

    const after = await db
      .selectFrom("core_scan_inbox_items")
      .select(["suggested_name", "suggested_metadata"])
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (after?.suggested_name) return; // resolved — a successful identify cleared retry_queued

    const afterMeta = (after?.suggested_metadata ?? null) as { rate_limited?: boolean; lookup_unreachable?: boolean } | null;
    const stillThrottled = !!afterMeta?.rate_limited;
    const cause: RetryCause = afterMeta?.lookup_unreachable ? "unreachable" : "busy";
    const { note, next } = retryStep(attemptNo, cause, RETRY_MAX_ATTEMPTS);

    if (!stillThrottled) {
      // The provider answered and simply has nothing. enrichBarcodeItem has
      // already written the honest "fill in manually" note, so this job's work
      // is finished even though the row has no name. Release the queued-retry
      // marker so a later throttled re-run can enqueue a fresh chain.
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_metadata: dropMeta(["retry_queued", "lookup_unreachable"]) as never, updated_at: new Date() })
        .where("id", "=", itemId)
        .execute();
      return;
    }

    // Tell the row where the retry has actually got to, then either queue the
    // next attempt on the chain's own schedule, or stop and say so. Never a
    // throw: that handed the wait to core-queue's global backoff, whose fourth
    // step is eighteen minutes (#3710).
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_notes: note,
        ...(lastChance
          ? // Budget spent. Drop the flags so the card stops rendering a
            // "retrying" state nothing is backing, and let the note say plainly
            // that this one needs a human or a photo.
            {
              suggested_metadata: mergeMeta({}, ["rate_limited", "retry_queued", "lookup_unreachable"]) as never,
              ai_suggested_at: new Date(),
            }
          : {}),
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();

    if (!next) return;
    await enqueueRetryLookup({ orgId: job.orgId, itemId, upc, orgSlug, attempt: next.attempt, delayMs: next.delayMs });
  });
}
