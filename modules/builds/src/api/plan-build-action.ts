// Plan this build (builds:plan-build): the handler its manifest entry names. Wired in ./index.ts.
// The same planned run as Plan on the schedule (POST /planned).
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { onBuild } from "./build-steps.js";
import { addPlannedBuild } from "./build-steps.js";

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function registerPlanBuildAction(): void {
  platform().actions.registerHandler("builds.plan-build", async (ctx) => {
    const build = requireActionEntity(ctx);
    const qty = num(ctx.args?.qty) ?? 1;
    if (!(qty > 0)) return { ok: false, error: "How many is more than zero." };
    const due = str(ctx.args?.due_date);
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, error: "The due date is a day, like 2026-10-23." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const row = await addPlannedBuild(db, ctx.orgId, build.id, { qty, due_date: due || null, priority: num(ctx.args?.priority) ?? 0, notes: str(ctx.args?.notes) || null });
    return { ok: true, summary: `Planned ${qty}${due ? ` for ${due}` : ""}; it is on the schedule.`, data: { plan: row.id } };
  });
  platform().actions.registerUndo("builds.plan-build", (result, uctx) => {
    const d = (result as { ok?: unknown; data?: { plan?: string } } | null);
    if (d?.ok !== true || !d.data?.plan) return null;
    return { action_id: "builds:remove-plan", args: { plan: d.data.plan }, ...onBuild(uctx) };
  });
}
