// Delete a job (digifab:delete-job): the handler its manifest entry names. Wired in ./index.ts.
// The same delete as on the queue (DELETE /jobs/:id): never a job that may still be on a printer.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { findJob } from "./job-lookup.js";
import { deleteQueuedJob } from "./jobs.js";

export function registerDeleteJobAction(): void {
  platform().actions.registerHandler("digifab.delete-job", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const job = await findJob(db, ctx.args?.job);
    if ("error" in job) return { ok: false, error: job.error };
    const r = await deleteQueuedJob(db as never, job.id);
    if (r.status !== 204) {
      const code = (r.body.error as { code?: string; message?: string } | undefined)?.code;
      return { ok: false, error: code === "active" ? `${job.file_ref} may still be on a printer. Stop it first.` : String((r.body.error as { message?: string } | undefined)?.message ?? "It could not be deleted.") };
    }
    return { ok: true, summary: `Removed ${job.file_ref} from the queue.`, data: { job: job.id } };
  });
}
