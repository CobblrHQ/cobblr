// Remove a step (builds:remove-step): the handler its manifest entry names. Wired in ./index.ts.
// The same delete as on the build's routing (DELETE /builds/:id/operations/:opId);
// the time and counts logged at it go with it, so it always asks first.
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { findStep, removeStep } from "./build-steps.js";

export function registerRemoveStepAction(): void {
  platform().actions.registerPlanner("builds.remove-step", async (ctx) => {
    const build = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const step = await findStep(db, build.id, ctx.args?.step);
    if ("error" in step) return { error: step.error };
    const [t, q] = await Promise.all([
      db.selectFrom("builds_op_time").select(({ fn }) => fn.countAll<number>().as("n")).where("operation_id", "=", step.id).executeTakeFirst(),
      db.selectFrom("builds_op_qty").select(({ fn }) => fn.countAll<number>().as("n")).where("operation_id", "=", step.id).executeTakeFirst(),
    ]);
    const logged = Number(t?.n ?? 0) + Number(q?.n ?? 0);
    return { title: `Remove the step ${step.name}`, lines: logged ? [`${logged} logged time or count entr${logged === 1 ? "y goes" : "ies go"} with it.`] : [] };
  });
  platform().actions.registerHandler("builds.remove-step", async (ctx) => {
    const build = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const step = await findStep(db, build.id, ctx.args?.step);
    if ("error" in step) return { ok: false, error: step.error };
    await removeStep(db, build.id, step.id);
    return { ok: true, summary: `Removed the step ${step.name}.`, data: { step: step.id } };
  });
}
