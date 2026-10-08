import { sql, type Kysely } from "kysely";
import { platform, readJsonArg } from "@cobblr/platform-contract";
import { z } from "zod";
import type { DigifabDB } from "./db.js";
import { buildDriverById, recordJobOutcome } from "./jobs-core.js";
import { CncOutcomeRefusal, finalCncRuntime } from "./cnc-outcomes.js";
import { confirmedCncRuntime, cncStockUses, mergeCncRuntime } from "./cnc-runtime.js";
import { consumeCncStock } from "./cnc-stock.js";
import { ReviewRequired } from "./drivers/job-review.js";

export const CncOutcomeBody = z.object({
  job_id: z.string().uuid(), outcome: z.enum(["good", "scrapped"]),
  tool_seconds: z.record(z.number().finite().nonnegative()).optional(),
});
const OutcomeAction = CncOutcomeBody.extend({ connection_id: z.string().uuid(), device_id: z.string().min(1).max(200) });

export async function recordCncOutcome(db: Kysely<DigifabDB>, orgId: string, connectionId: string, deviceId: string, body: z.infer<typeof CncOutcomeBody>, userId: string | null): Promise<void> {
  const locked = await platform().exclusive.run(`laser-start:${orgId}:${connectionId}:${deviceId}`, async () => {
    const job = await db.selectFrom("digifab_jobs").selectAll().where("id", "=", body.job_id).where("connection_id", "=", connectionId).where("target_device", "=", deviceId).executeTakeFirst();
    if (!job?.cnc_setup || !["completed", "failed", "cancelled"].includes(job.status)) throw new CncOutcomeRefusal("job_not_finished", "Record the finished CNC job's outcome at its machine.");
    const attention = await db.selectFrom("digifab_device_attention").select("job_id").where("connection_id", "=", connectionId).where("remote_device_id", "=", deviceId).executeTakeFirst();
    if (!job.cnc_usage_recorded_at && attention?.job_id !== job.id) throw new CncOutcomeRefusal("job_changed", "The station's job changed. Record the current piece's outcome.");
    if (job.cnc_usage_report && job.cnc_usage_report[0]?.outcome !== body.outcome) throw new CncOutcomeRefusal("outcome_recorded", "This CNC attempt already has a stock outcome. Keep its recorded verdict.");
    if (!job.cnc_usage_recorded_at) {
      const driver = await buildDriverById(db, orgId, connectionId);
      if (!driver || await driver.jobReviewKind?.() !== "cnc") throw new CncOutcomeRefusal("machine_unavailable", "Connect the CNC controller before recording its stock and bit use.");
      const seconds = job.cnc_usage_report ? null : await finalCncRuntime(driver, deviceId, job.remote_job_id, job.cnc_tool_seconds, job.cnc_setup.tools, job.status === "completed", body.tool_seconds);
      if (job.cnc_usage_report) {
        const machine = (await driver.listDevices()).find(device => device.id === deviceId);
        if (!machine?.enabled || machine.state?.toLowerCase() !== "idle") throw new CncOutcomeRefusal("machine_not_idle", "Confirm the CNC controller is idle before recording this outcome.");
      }
      const uses = await db.transaction().execute(async trx => {
        const current = await trx.selectFrom("digifab_jobs").selectAll().where("id", "=", job.id).forUpdate().executeTakeFirstOrThrow();
        if (!current.cnc_setup) throw new CncOutcomeRefusal("job_changed", "The CNC attempt changed. Check its recorded outcome.");
        if (current.cnc_usage_report) return current.cnc_usage_report;
        let actual;
        try {
          if (body.tool_seconds) confirmedCncRuntime(current.cnc_tool_seconds, body.tool_seconds, current.cnc_setup.tools);
          actual = mergeCncRuntime(current.cnc_tool_seconds, seconds, current.cnc_setup.tools);
        } catch (e) {
          throw new CncOutcomeRefusal("runtime_confirmation_required", e instanceof Error ? e.message : "Check actual tool runtime.", { tools: current.cnc_setup.tools.map(tool => ({ number: tool.number, observedSeconds: current.cnc_tool_seconds[String(tool.number)] ?? 0 })) });
        }
        const report = cncStockUses(current.cnc_setup, actual, body.outcome);
        await trx.updateTable("digifab_jobs").set({ cnc_tool_seconds: actual, cnc_usage_report: sql<typeof report>`${JSON.stringify(report)}::jsonb` }).where("id", "=", job.id).execute();
        return report;
      });
      // Freeze business use first; fresh inventory revisions let a partial retry deduplicate each source.
      await consumeCncStock(orgId, userId, uses);
      await db.updateTable("digifab_jobs").set({ cnc_usage_recorded_at: new Date() }).where("id", "=", job.id).where("cnc_usage_recorded_at", "is", null).execute();
    }
    await recordJobOutcome(db, orgId, job.id, body.outcome === "good" ? "good" : "scrap", "bed-clear");
    await db.transaction().execute(async trx => {
      await trx.deleteFrom("digifab_laser_sheet_claims").where("job_id", "=", job.id).execute();
      await trx.deleteFrom("digifab_device_attention").where("connection_id", "=", connectionId).where("remote_device_id", "=", deviceId).where("job_id", "=", job.id).execute();
    });
  });
  if (!locked.ran) throw new CncOutcomeRefusal("machine_busy", "This machine is preparing, starting or recording a job. Wait before recording its outcome.");
}

export function registerCncOutcomeAction(): void {
  platform().actions.registerHandler("digifab.machine-outcome", async ctx => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "admin" })) return { ok: false, error: "An owner or admin records this machine's outcome." };
    const args = ctx.args ?? {};
    const parsed = OutcomeAction.safeParse({ ...args, tool_seconds: readJsonArg(args, "tool_seconds") ?? args.tool_seconds });
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
    try { await recordCncOutcome(db, ctx.orgId, parsed.data.connection_id, parsed.data.device_id, parsed.data, ctx.userId); return { ok: true }; }
    catch (e) { if (!(e instanceof CncOutcomeRefusal) && !(e instanceof ReviewRequired)) throw e; return { ok: false, error: e.message, code: e instanceof CncOutcomeRefusal ? e.code : "stock_not_recorded", details: e instanceof CncOutcomeRefusal ? e.details : undefined }; }
  });
}
