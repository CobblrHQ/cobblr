// The queue side of a send: a retry that is due, or a send that waited its turn.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreIntegrationsDB } from "./db.js";
import { SEND_QUEUE, invokeSavedConnector, type SendJob, type SendPlan } from "./invoke-saved.js";

const WORKER_WAIT_MS = 8_000;

/** How a queued send is run: its try number, and the key it has carried since
 *  the first try, so a remote that dedupes by it sees one send, not several. */
export function planOfJob(p: Pick<SendJob, "attempt" | "key">): SendPlan {
  return { attempt: p.attempt, maxWaitMs: WORKER_WAIT_MS, key: p.key };
}

let registered = false;

export function registerSendWorker(): void {
  if (registered) return;
  registered = true;
  platform().queue.registerWorker(SEND_QUEUE, async (job) => {
    const p = job.payload as unknown as SendJob;
    const db = (await platform().tenants.getDb(job.orgId)) as Kysely<CoreIntegrationsDB>;
    // A connection removed or switched off since the retry was set is a send
    // nobody wants any more: the outcome says so and there is nothing to do.
    await invokeSavedConnector(db, job.orgId, p.rowId, p.actionId, p.args ?? {}, p.rendered, planOfJob(p));
  });
}
