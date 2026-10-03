/** A hosted identify the service queued, collected and landed (#43 in
 *  barcode-intelligence).
 *
 *  The hosted service never fails a photo for an engine being out: when the
 *  owner's Claude bridge has run out for the night, Gemini's free tier is
 *  busy and the LAN model asleep, it accepts the photo as a job and answers
 *  when an engine is back. The scan then says "Identifying. Back shortly."
 *  (enrich-photo.ts), never "unidentified", and this worker asks for the job
 *  on a schedule until it is answered, then lands the answer through the
 *  same read a direct answer takes (enrichPhotoItem with the answer in hand,
 *  then finishPhotoRead): the same name, the same receipt route, the same
 *  enriched event, as if it had answered at once.
 *
 *  Bounded: the waits grow to half an hour and the chain stops after
 *  HOSTED_JOB_GIVE_UP_MS, when the row is told plainly it was not identified
 *  and can be identified again. The same core-queue machinery as the barcode
 *  retry (retry-worker.ts): persistent, safe across api instances, and the
 *  chain keeps its own schedule in the payload. */

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { identifyFailureWords, type IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";
import type { CoreScanDB } from "../db.js";
import { hostedIdentifyJob, type HostedJobState } from "./hosted-identify.js";
import { mergeMeta } from "./metadata.js";

export const HOSTED_JOB_QUEUE = "core-scan:hosted-identify-job";

/** The waits between asks: soon at first (an engine that was only busy is
 *  back within minutes), then every half hour (the bridge's window resets at
 *  a fixed hour of the night). */
export const HOSTED_JOB_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000];

/** How long a queued identify is waited for before the row is told. The
 *  service keeps a job three days; a night's outage is the case this is for. */
export const HOSTED_JOB_GIVE_UP_MS = 24 * 3600_000;

/** The wait before ask n+1, after ask n (1-based) found the job still queued. */
export function nextHostedJobDelayMs(askNo: number): number {
  return HOSTED_JOB_DELAYS_MS[Math.min(Math.max(askNo - 1, 0), HOSTED_JOB_DELAYS_MS.length - 1)]!;
}

interface JobPayload {
  itemId?: unknown;
  jobId?: unknown;
  imageFileId?: unknown;
  userId?: unknown;
  ask?: unknown;
  since?: unknown;
}

export async function enqueueHostedIdentifyJob(args: {
  orgId: string;
  itemId: string;
  jobId: string;
  imageFileId: string;
  userId: string | null;
  ask?: number;
  since?: string;
  delayMs?: number;
}): Promise<void> {
  const ask = args.ask ?? 1;
  await platform().queue.enqueue({
    orgId: args.orgId,
    queue: HOSTED_JOB_QUEUE,
    payload: { itemId: args.itemId, jobId: args.jobId, imageFileId: args.imageFileId, userId: args.userId, ask, since: args.since ?? new Date().toISOString() },
    runAt: new Date(Date.now() + (args.delayMs ?? HOSTED_JOB_DELAYS_MS[0]!)),
    // A run that throws (a database error, not a queued job) is retried by
    // the queue once more; the chain's own schedule is in the payload.
    maxAttempts: 2,
  });
}

/** What one ask decided, for the worker and its test: pure. */
export type HostedJobStep =
  | { do: "land" }
  | { do: "wait"; delayMs: number }
  | { do: "give-up"; failure: IdentifyFailure };

export function hostedJobStep(state: HostedJobState, askNo: number, sinceMs: number, now = Date.now()): HostedJobStep {
  if (state.state === "done") return { do: "land" };
  if (state.state === "failed") return { do: "give-up", failure: { code: "no_answer", ai: "no-answer", reason: `hosted identify gave up: ${state.message}` } };
  if (state.state === "lost") return { do: "give-up", failure: { code: "ai_unavailable", ai: "provider-error", ai_reason: "unreachable", hosted: "unreachable", reason: "the hosted identify no longer knows this job" } };
  const delayMs = nextHostedJobDelayMs(askNo);
  if (now + delayMs - sinceMs > HOSTED_JOB_GIVE_UP_MS) {
    return { do: "give-up", failure: { code: "ai_unavailable", ai: "provider-error", ai_reason: "busy", hosted: "unreachable", reason: "the hosted identify did not answer within a day" } };
  }
  return { do: "wait", delayMs };
}

export function registerHostedIdentifyJobWorker(): void {
  platform().queue.registerWorker(HOSTED_JOB_QUEUE, async (job) => {
    const p = job.payload as JobPayload;
    const itemId = typeof p.itemId === "string" ? p.itemId : "";
    const jobId = typeof p.jobId === "string" ? p.jobId : "";
    const imageFileId = typeof p.imageFileId === "string" ? p.imageFileId : "";
    if (!itemId || !jobId || !imageFileId) return; // nothing actionable
    const userId = typeof p.userId === "string" ? p.userId : null;
    const askNo = typeof p.ask === "number" && p.ask >= 1 ? p.ask : 1;
    const since = typeof p.since === "string" ? p.since : new Date().toISOString();

    const db = (await platform().tenants.getDb(job.orgId)) as unknown as Kysely<CoreScanDB>;
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["status", "suggested_name", "suggested_metadata", "image_file_id"])
      .where("id", "=", itemId)
      .executeTakeFirst();
    // Discarded, named meanwhile (a person, a re-run), its photo replaced, or
    // waiting on a newer job: this job's answer has nowhere to go.
    const waitingOn = (row?.suggested_metadata as { hosted_identify_job?: { id?: string } } | null)?.hosted_identify_job?.id;
    if (!row || row.status !== "pending" || row.suggested_name || row.image_file_id !== imageFileId || waitingOn !== jobId) return;

    const state = await hostedIdentifyJob(jobId);
    const step = hostedJobStep(state, askNo, Date.parse(since));
    if (step.do === "wait") {
      await enqueueHostedIdentifyJob({ orgId: job.orgId, itemId, jobId, imageFileId, userId, ask: askNo + 1, since, delayMs: step.delayMs });
      return;
    }
    if (step.do === "give-up") {
      console.log(`[core-scan] org ${job.orgId} row ${itemId}: hosted identify ${jobId} ended unanswered (${step.failure.reason})`);
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          ai_notes: identifyFailureWords(step.failure).sentence,
          ai_suggested_at: new Date(),
          updated_at: new Date(),
          // A receipt read that never came stops saying it is reading.
          suggested_metadata: mergeMeta({ identify_failure: { code: step.failure.code, ai: step.failure.ai, ...(step.failure.ai_reason ? { ai_reason: step.failure.ai_reason } : {}), ...(step.failure.hosted ? { hosted: step.failure.hosted } : {}) } }, ["hosted_identify_job", "reading_receipt"]) as never,
        })
        .where("id", "=", itemId)
        .execute();
      return;
    }
    // Answered: the same read a direct answer takes, with the answer in hand.
    if (state.state !== "done") return;
    const { enrichPhotoItem } = await import("./enrich-photo.js");
    const { finishPhotoRead } = await import("./photo-read-finish.js");
    const outcome = await enrichPhotoItem({ db, orgId: job.orgId, itemId, imageFileId, userId, hostedAnswer: state.answer });
    // The receipt route collects THIS job's answer rather than asking again,
    // so a receipt the service read while queued is filed from that read.
    await finishPhotoRead({ orgId: job.orgId, itemId, fileId: imageFileId, userId, outcome, hostedJobId: jobId });
    console.log(`[core-scan] org ${job.orgId} row ${itemId}: hosted identify ${jobId} landed (${outcome}) after ${askNo} ask(s)`);
  });
}
