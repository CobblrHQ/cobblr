// Log time on a step (builds:log-step-time): the handler its manifest entry names. Wired in ./index.ts.
// The same entry as Log time on a step (POST /builds/:id/operations/:opId/time).
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { findStep, logStepTime } from "./build-steps.js";

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function registerLogStepTimeAction(): void {
  platform().actions.registerHandler("builds.log-step-time", async (ctx) => {
    const build = requireActionEntity(ctx);
    const minutes = num(ctx.args?.minutes);
    if (!(minutes != null && minutes >= 0)) return { ok: false, error: "Say how many minutes." };
    const kind = (str(ctx.args?.kind) || "labor").toLowerCase();
    if (!["labor", "machine", "setup"].includes(kind)) return { ok: false, error: "The time is labor, machine or setup." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const step = await findStep(db, build.id, ctx.args?.step);
    if ("error" in step) return { ok: false, error: step.error };
    await logStepTime(db, ctx.orgId, build.id, step, { kind: kind as "labor" | "machine" | "setup", minutes, notes: str(ctx.args?.notes) || null }, ctx.userId);
    return { ok: true, summary: `Logged ${minutes} minutes of ${kind} time on ${step.name}.`, data: { step: step.id } };
  });
}
