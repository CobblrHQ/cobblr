// Add a step (builds:add-step): the handler its manifest entry names. Wired in ./index.ts.
// The same append as Add step on the build's routing (POST /builds/:id/operations).
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { onBuild } from "./build-steps.js";
import { addStep } from "./build-steps.js";

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function registerAddStepAction(): void {
  platform().actions.registerHandler("builds.add-step", async (ctx) => {
    const build = requireActionEntity(ctx);
    const name = str(ctx.args?.name).slice(0, 200);
    if (!name) return { ok: false, error: "Say what the step is called." };
    const est = num(ctx.args?.est_minutes);
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const row = await addStep(db, ctx.orgId, build.id, { name, description: str(ctx.args?.description) || null, est_minutes: est ?? null });
    return { ok: true, summary: `Added the step ${row.name}${est != null ? ` (${est} minutes)` : ""} at the end of this build's routing.`, data: { step: row.id } };
  });
  platform().actions.registerUndo("builds.add-step", (result, uctx) => {
    const d = (result as { ok?: unknown; data?: { step?: string } } | null);
    if (d?.ok !== true || !d.data?.step) return null;
    return { action_id: "builds:remove-step", args: { step: d.data.step }, ...onBuild(uctx) };
  });
}
