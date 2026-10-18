// Move a job up or down the queue (digifab:prioritize-job): the handler its manifest entry names. Wired in ./index.ts.
// The same write as the job's priority on the queue (PATCH /jobs/:id); nothing is sent to a machine.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { findJob } from "./job-lookup.js";
import { JobPatch, patchJob } from "./jobs.js";

export function registerPrioritizeJobAction(): void {
  platform().actions.registerHandler("digifab.prioritize-job", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
    const change = JobPatch.pick({ priority: true, max_attempts: true }).safeParse({ priority: n(a.priority), max_attempts: n(a.max_attempts) });
    if (!change.success) return { ok: false, error: "Priority is 0 to 100 (higher goes first), and tries are 1 to 10." };
    if (change.data.priority == null && change.data.max_attempts == null) return { ok: false, error: "Say the priority or how many tries." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const job = await findJob(db, a.job);
    if ("error" in job) return { ok: false, error: job.error };
    const row = await patchJob(db as never, ctx.orgId, job.id, change.data);
    if (!row) return { ok: false, error: "That job is gone." };
    const said = [...(change.data.priority != null ? [`priority ${row.priority}`] : []), ...(change.data.max_attempts != null ? [`up to ${row.max_attempts} tries`] : [])];
    return { ok: true, summary: `${job.file_ref}: ${said.join(", ")}.`, data: { job: job.id, before: { priority: job.priority, max_attempts: job.max_attempts } } };
  });
  platform().actions.registerUndo("digifab.prioritize-job", (result) => {
    const d = (result as { ok?: unknown; data?: { job?: string; before?: { priority: number; max_attempts: number } } } | null);
    if (d?.ok !== true || !d.data?.job || !d.data.before) return null;
    return { action_id: "digifab:prioritize-job", args: { job: d.data.job, ...d.data.before } };
  });
}
