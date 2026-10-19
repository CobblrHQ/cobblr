// Change a step (builds:change-step): the handler its manifest entry names. Wired in ./index.ts.
// The same write as editing a step on the build's routing (PATCH /builds/:id/operations/:opId).
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { onBuild } from "./build-steps.js";
import { changeStep, findStep, type StepChange } from "./build-steps.js";

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const STATUSES = ["todo", "doing", "done", "skipped"] as const;

export function registerChangeStepAction(): void {
  platform().actions.registerHandler("builds.change-step", async (ctx) => {
    const build = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const change: StepChange = {};
    if (str(a.status)) {
      const st = str(a.status).toLowerCase() as (typeof STATUSES)[number];
      if (!STATUSES.includes(st)) return { ok: false, error: "A step is todo, doing, done or skipped." };
      change.status = st;
    }
    if (str(a.name)) change.name = str(a.name).slice(0, 200);
    if (num(a.position) != null) change.seq = Math.round(num(a.position)!);
    if (a.est_minutes !== undefined) change.est_minutes = num(a.est_minutes) ?? null;
    if (a.notes !== undefined) change.notes = str(a.notes) || null;
    if (!Object.keys(change).length) return { ok: false, error: "Say what to change: status, name, position, minutes or notes." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const step = await findStep(db, build.id, a.step);
    if ("error" in step) return { ok: false, error: step.error };
    const out = await changeStep(db, ctx.orgId, build.id, step.id, change);
    if (!out) return { ok: false, error: "That step is gone." };
    const b = out.before;
    return {
      ok: true,
      summary: change.status ? `${out.row.name} is ${out.row.status}.` : `Changed the step ${out.row.name}.`,
      data: { step: step.id, before: { status: b.status, name: b.name, position: b.seq, est_minutes: b.est_minutes == null ? null : Number(b.est_minutes), notes: b.notes ?? "" } },
    };
  });
  platform().actions.registerUndo("builds.change-step", (result, uctx) => {
    const d = (result as { ok?: unknown; data?: { step?: string; before?: Record<string, unknown> } } | null);
    if (d?.ok !== true || !d.data?.step || !d.data.before) return null;
    return { action_id: "builds:change-step", args: { step: d.data.step, ...d.data.before }, ...onBuild(uctx) };
  });
}
