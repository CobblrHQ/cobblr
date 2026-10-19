// Remove a planned build (builds:remove-plan): the handler its manifest entry names. Wired in ./index.ts.
// The same delete as on the schedule (DELETE /planned/:pid).
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { findPlan, removePlan } from "./build-steps.js";

export function registerRemovePlanAction(): void {
  platform().actions.registerHandler("builds.remove-plan", async (ctx) => {
    const build = requireActionEntity(ctx);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const plan = await findPlan(db, build.id, ctx.args?.plan);
    if ("error" in plan) return { ok: false, error: plan.error };
    await removePlan(db, plan.id);
    return { ok: true, summary: "Took the planned run off the schedule.", data: { plan: plan.id } };
  });
}
