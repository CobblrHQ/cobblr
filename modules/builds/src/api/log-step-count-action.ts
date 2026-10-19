// Count good or scrap at a step (builds:log-step-count): the handler its manifest entry names. Wired in ./index.ts.
// The same entry as Log quantity on a step (POST /builds/:id/operations/:opId/quantities).
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { findStep, logStepCount } from "./build-steps.js";

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function registerLogStepCountAction(): void {
  platform().actions.registerHandler("builds.log-step-count", async (ctx) => {
    const build = requireActionEntity(ctx);
    const quantity = num(ctx.args?.quantity);
    if (!(quantity != null && quantity > 0)) return { ok: false, error: "Say how many." };
    const kind = str(ctx.args?.kind).toLowerCase();
    if (!["good", "scrap", "rework"].includes(kind)) return { ok: false, error: "The count is good, scrap or rework." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const step = await findStep(db, build.id, ctx.args?.step);
    if ("error" in step) return { ok: false, error: step.error };
    await logStepCount(db, ctx.orgId, build.id, step, { kind: kind as "good" | "scrap" | "rework", quantity, reason: str(ctx.args?.reason) || null }, ctx.userId);
    return { ok: true, summary: `Counted ${quantity} ${kind} at ${step.name}.`, data: { step: step.id } };
  });
}
