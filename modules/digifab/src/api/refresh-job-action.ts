// Refresh a job's status (digifab:refresh-job): the handler its manifest entry names. Wired in ./index.ts.
// The queue's "refresh status" (POST /jobs/:id/poll): it asks the printer, it never starts or stops anything.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { pollJob } from "../jobs-core.js";
import { findJob } from "./job-lookup.js";

export function registerRefreshJobAction(): void {
  platform().actions.registerHandler("digifab.refresh-job", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const job = await findJob(db, ctx.args?.job);
    if ("error" in job) return { ok: false, error: job.error };
    const r = (await pollJob(db as never, ctx.orgId, job.id)) as { status?: string; progress?: number | null } | null;
    if (!r) return { ok: false, error: `${job.file_ref} has not been sent to a printer yet, so there is nothing to ask.` };
    const pct = typeof r.progress === "number" ? `, ${Math.round(r.progress)} percent done` : "";
    return { ok: true, summary: `${job.file_ref} is ${r.status ?? job.status}${pct}.`, data: { job: job.id, ...r } };
  });
}
