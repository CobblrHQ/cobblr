// Change a planned build (builds:change-plan): the handler its manifest entry names. Wired in ./index.ts.
// The same write as editing a planned run on the schedule (PATCH /planned/:pid).
import { platform, requireActionEntity } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { BuildsDB } from "../db.js";
import { onBuild } from "./build-steps.js";
import { changePlan, findPlan, type PlanChange } from "./build-steps.js";

const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function registerChangePlanAction(): void {
  platform().actions.registerHandler("builds.change-plan", async (ctx) => {
    const build = requireActionEntity(ctx);
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    const change: PlanChange = {};
    if (num(a.qty) != null) change.qty = num(a.qty);
    if (a.due_date !== undefined) {
      const due = str(a.due_date);
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, error: "The due date is a day, like 2026-10-23." };
      change.due_date = due || null;
    }
    if (num(a.priority) != null) change.priority = Math.round(num(a.priority)!);
    if (str(a.status)) {
      const st = str(a.status).toLowerCase();
      if (!["planned", "done", "cancelled"].includes(st)) return { ok: false, error: "A planned run is planned, done or cancelled." };
      change.status = st as PlanChange["status"];
    }
    if (a.notes !== undefined) change.notes = str(a.notes) || null;
    if (!Object.keys(change).length) return { ok: false, error: "Say what to change: how many, the due date, priority, status or notes." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<BuildsDB>;
    const plan = await findPlan(db, build.id, a.plan);
    if ("error" in plan) return { ok: false, error: plan.error };
    const out = await changePlan(db, ctx.orgId, plan.id, change);
    if (!out) return { ok: false, error: "That planned run is gone." };
    const b = out.before;
    return {
      ok: true,
      summary: `The planned run is now ${Number(out.row.qty)}${out.row.due_date ? ` for ${String(out.row.due_date).slice(0, 10)}` : ""}, ${out.row.status}.`,
      data: { plan: plan.id, before: { qty: Number(b.qty), due_date: b.due_date ? String(b.due_date).slice(0, 10) : "", priority: b.priority, status: b.status, notes: b.notes ?? "" } },
    };
  });
  platform().actions.registerUndo("builds.change-plan", (result, uctx) => {
    const d = (result as { ok?: unknown; data?: { plan?: string; before?: Record<string, unknown> } } | null);
    if (d?.ok !== true || !d.data?.plan || !d.data.before) return null;
    return { action_id: "builds:change-plan", args: { plan: d.data.plan, ...d.data.before }, ...onBuild(uctx) };
  });
}
