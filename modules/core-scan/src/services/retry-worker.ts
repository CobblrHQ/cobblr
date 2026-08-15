/** The core-queue worker that actually re-runs a throttled barcode look-up.
 *
 *  Separate from `retry-lookup.ts` on purpose: that module is imported BY
 *  `enrich.ts` (to enqueue), and this one imports `enrich.ts` (to run). Keeping
 *  the policy and the worker apart is what stops that being an import cycle. */

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";
import { enrichBarcodeItem } from "./enrich.js";
import { mergeMeta } from "./metadata.js";
import { RETRY_LOOKUP_QUEUE, RETRY_MAX_ATTEMPTS, retriesExhausted, retryNote } from "./retry-lookup.js";

interface RetryPayload {
  itemId?: unknown;
  upc?: unknown;
  orgSlug?: unknown;
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

    // `attempts` is this attempt's number, so the LAST one has to finish
    // cleanly rather than throw: a throw here would mark the job failed and
    // leave the row still claiming a retry was coming.
    const lastChance = retriesExhausted(job.attempts, RETRY_MAX_ATTEMPTS);

    await enrichBarcodeItem({
      db,
      orgId: job.orgId,
      itemId,
      orgSlug,
      upc,
      // The rate-limited outcome was deliberately never cached, but force also
      // skips the tenant cache's stale miss if one landed since.
      force: true,
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
    if (after?.suggested_name) return; // resolved — done

    const stillThrottled =
      !!(after?.suggested_metadata as { rate_limited?: boolean } | null)?.rate_limited;

    if (!stillThrottled) {
      // The provider answered and simply has nothing. enrichBarcodeItem has
      // already written the honest "fill in manually" note, so this job's work
      // is finished even though the row has no name.
      return;
    }

    // Tell the row where the retry has actually got to, then either give
    // core-queue a reason to schedule the next attempt, or stop and say so.
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        ai_notes: retryNote(job.attempts, RETRY_MAX_ATTEMPTS),
        ...(lastChance
          ? // Budget spent. Drop the flag so the card stops rendering a
            // "retrying" state nothing is backing, and let the note say plainly
            // that this one needs a human or a photo.
            { suggested_metadata: mergeMeta({}, ["rate_limited"]) as never, ai_suggested_at: new Date() }
          : {}),
        updated_at: new Date(),
      })
      .where("id", "=", itemId)
      .execute();

    if (lastChance) return;
    throw new Error(`barcode ${upc} still rate-limited (attempt ${job.attempts})`);
  });
}
