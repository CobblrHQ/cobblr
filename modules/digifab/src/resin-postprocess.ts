import { z } from "zod";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
export const ResinPostprocess = z.object({ job_id: z.string().uuid(), step: z.enum(["wash", "cure"]) });
export async function finishResinPostprocess(db: Kysely<DigifabDB>, jobId: string, step: "wash" | "cure") {
  const row = await db.selectFrom("digifab_resin_prints as p").innerJoin("digifab_jobs as j", "j.id", "p.job_id")
    .select(["p.phase", "p.wash_done", "p.cure_done", "j.outcome"]).where("p.job_id", "=", jobId).executeTakeFirst();
  if (!row || row.phase !== "settled" || row.outcome !== "good") return { ok: false, error: "Record a good resin print and its stock use before washing and curing." };
  if (step === "cure" && !row.wash_done) return { ok: false, error: "Wash this print before marking it cured." };
  let update = db.updateTable("digifab_resin_prints").set(step === "wash" ? { wash_done: true, updated_at: new Date() } : { cure_done: true, updated_at: new Date() }).where("job_id", "=", jobId).where("phase", "=", "settled");
  if (step === "cure") update = update.where("wash_done", "=", true);
  await update.execute();
  return { ok: true };
}
export function registerResinPostprocessAction() {
  platform().actions.registerHandler("digifab.resin-postprocess", async ctx => {
    if (!ctx.userId || !await platform().auth.userHasRole({ orgId: ctx.orgId, userId: ctx.userId, minRole: "member" })) return { ok: false, error: "Sign in to record washing and curing." };
    const parsed = ResinPostprocess.safeParse(ctx.args);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<DigifabDB>;
    return finishResinPostprocess(db, parsed.data.job_id, parsed.data.step);
  });
}
