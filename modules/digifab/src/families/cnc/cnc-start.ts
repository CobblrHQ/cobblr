import { createHash, randomUUID } from "node:crypto";
import type { Kysely, Selectable } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { CncApprovalSchema, CncMachineSchema } from "@cobblr/platform-contract/cnc";
import type { DigifabDB } from "../../db.js";
import type { JobApproval, JobReview } from "../../drivers/types.js";
import { ReviewRequired } from "../../drivers/job-review.js";
import { parseCncProgram } from "./cnc-program.js";
import { cncStockSelection } from "./cnc-preflight.js";
import { requireCncStock, requireCncLoadedStock } from "./cnc-stock.js";
import type { CncUseSnapshot } from "./cnc-runtime.js";

type Job = Pick<Selectable<DigifabDB["digifab_jobs"]>, "id" | "file_id" | "connection_id" | "target_device">;

export async function validateCncStock(orgId: string, job: Job, approval: JobApproval, review: JobReview, stationId: string) {
  if (review.project.kind !== "cnc" || review.fileId !== approval.fileId || review.projectHash !== approval.projectHash) throw new ReviewRequired("The CNC program or machine settings changed. Review this program again.");
  const parsed = CncApprovalSchema.safeParse(approval.cnc), machine = CncMachineSchema.safeParse(review.project.machine);
  if (!parsed.success || !machine.success) throw new ReviewRequired("Confirm the stock, tool library and machine checklist at this station.");
  const file = job.file_id ? await platform().files.read(orgId, job.file_id) : null;
  if (!file || review.contentHash !== createHash("sha256").update(file.bytes).digest("hex")) throw new ReviewRequired("The queued CNC file changed. Review its posted program again.");
  const stock = await requireCncStock(orgId, parsed.data.stockId);
  const tools = await Promise.all([...new Set(parsed.data.tools.map(tool => tool.partId))].map(id => requireCncStock(orgId, id)));
  await requireCncLoadedStock(orgId, stationId, [stock.id, ...tools.map(tool => tool.id)]);
  try {
    const program = parseCncProgram(Buffer.from(file.bytes).toString("utf8"), machine.data.rapidFeed);
    const selected = cncStockSelection(program, machine.data, stock, tools, parsed.data);
    return { stock, selected };
  } catch (e) { throw new ReviewRequired(e instanceof Error ? e.message : "Review the CNC stock and tool library again."); }
}

export async function claimCncStock(db: Kysely<DigifabDB>, orgId: string, job: Job, approval: JobApproval, review: JobReview, stationId: string): Promise<void> {
  const { stock, selected } = await validateCncStock(orgId, job, approval, review, stationId);
  const snapshot: CncUseSnapshot = { jobId: job.id, executionId: randomUUID(), stockId: stock.id, shape: stock.shape as "sheet" | "count", region: selected.region, tools: selected.tools };
  await db.transaction().execute(async trx => {
    const current = await trx.selectFrom("digifab_jobs").select(["remote_job_id", "status", "cancel_requested_at", "cnc_setup", "cnc_usage_recorded_at"]).where("id", "=", job.id).forUpdate().executeTakeFirst();
    if (!current || !["queued", "assigning"].includes(current.status) || current.remote_job_id || current.cancel_requested_at) throw new ReviewRequired("This CNC job is no longer ready to Start. Review it again.");
    if (current.cnc_setup && !current.cnc_usage_recorded_at) throw new ReviewRequired("Record this CNC attempt's stock and bit use before another Start.");
    // The shared physical claim also prevents a laser batch from taking a CNC sheet.
    for (const partId of [...new Set([stock.id, ...selected.tools.map(tool => tool.partId)])].sort()) {
      const claim = await trx.insertInto("digifab_laser_sheet_claims").values({ part_id: partId, plan_id: null, job_id: job.id }).onConflict(oc => oc.column("part_id").doNothing()).returning("part_id").executeTakeFirst();
      if (!claim) throw new ReviewRequired("This stock or bit is reserved for another workshop job. Finish that job or choose another record.");
    }
    await trx.updateTable("digifab_jobs").set({ cnc_setup: snapshot, cnc_tool_seconds: {}, cnc_usage_report: null, cnc_usage_recorded_at: null }).where("id", "=", job.id).execute();
  });
}

export async function releaseUnstartedCncStock(db: Kysely<DigifabDB>, jobId: string): Promise<void> {
  await db.transaction().execute(async trx => {
    const job = await trx.selectFrom("digifab_jobs").select(["remote_job_id", "cnc_setup"]).where("id", "=", jobId).forUpdate().executeTakeFirst();
    if (!job?.cnc_setup || job.remote_job_id) return;
    await trx.deleteFrom("digifab_laser_sheet_claims").where("job_id", "=", jobId).execute();
    await trx.updateTable("digifab_jobs").set({ cnc_setup: null, cnc_tool_seconds: {}, cnc_usage_report: null, cnc_usage_recorded_at: null }).where("id", "=", jobId).execute();
  });
}
